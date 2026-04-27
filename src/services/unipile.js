/**
 * Unipile Service — WhatsApp via Unipile API
 * v2: Deduplicação de mensagens, reset bot_away_sent, structured logging
 */
import 'dotenv/config';
import {
    findConversationByChat, createConversation, updateConversation,
    findLeadByPhone, createLead, updateLead, saveMessage, normalizePhone
} from './supabase.js';
import { processChatbotMessage } from './chatbot-engine.js';
import { isLLMBotAvailable } from './llm-bot.js';
import { onInboundMessage } from './auto-activities.js';
import { findPersonByPhone, findPersonByEmail, findPersonByExactName, getDealsForPerson } from './pipedrive.js';
import { isApolloConfigured, matchPerson } from './apollo.js';
import { getSettingValue } from './supabase.js';
import whatsapp from '../providers/index.js';
import logger from './logger.js';

// ─── Config ───────────────────────────────────────────────────────────
const API_KEY = process.env.UNIPILE_API_KEY;
const DSN     = process.env.UNIPILE_DSN;
const ACCT_ID = process.env.UNIPILE_ACCOUNT_ID;
const BASE    = DSN ? `https://${DSN}/api/v1` : null;

let _pollingInterval = null;
let _lastPollTime    = Date.now() - 60_000;

// Cache: unipile_account_id → { user_id, user_name, expires_at }
const _accountOwnerCache = new Map();
const ACCOUNT_OWNER_TTL_MS = 5 * 60_000;

/**
 * Cascata de estratégias pra achar a Person do Pipedrive sem exigir match
 * exato de phone. Só aceita match UNÍVOCO — ambiguidade sempre retorna null.
 *
 * Strategies em ordem:
 *   1. phone_exact          — variações BR (com/sem 9, com/sem 55)
 *   2. name_exact           — nome do Unipile (único match)
 *   3. apollo_email         — Apollo descobre email → search por email (único match)
 *
 * Apollo só roda se platform_settings.apollo_auto_match=true (controle de crédito).
 */
async function smartMatchPipedrivePerson({ phone, name }) {
    // 1. Phone (já cobre variações BR via normalizePhoneTerms)
    const byPhone = await findPersonByPhone(phone).catch(() => null);
    if (byPhone) return { person: byPhone, strategy: 'phone_exact' };

    // 2. Nome exato (só se Unipile trouxe nome real, não telefone)
    if (name && !/^\+?\d[\d\s\-()]+$/.test(name.trim()) && name.length >= 3) {
        const byName = await findPersonByExactName(name).catch(() => null);
        if (byName) return { person: byName, strategy: 'name_exact' };
    }

    // 3. Apollo (opt-in)
    try {
        const autoMatchEnabled = await getSettingValue('apollo_auto_match', false);
        if (!autoMatchEnabled || !isApolloConfigured()) return null;

        const apolloResp = await matchPerson({
            phone_number: phone,
            name: (name && !/^\+?\d/.test(name)) ? name : undefined,
        });
        if (!apolloResp?.matched || !apolloResp.person) return null;

        // Tenta email (mais preciso)
        if (apolloResp.person.email) {
            const byEmail = await findPersonByEmail(apolloResp.person.email).catch(() => null);
            if (byEmail) return { person: byEmail, strategy: 'apollo_email' };
        }

        // Tenta nome descoberto pelo Apollo
        if (apolloResp.person.name) {
            const byApolloName = await findPersonByExactName(apolloResp.person.name).catch(() => null);
            if (byApolloName) return { person: byApolloName, strategy: 'apollo_name' };
        }
    } catch (err) {
        logger.warn('smartMatch Apollo step failed', { phone, error: err.message });
    }

    return null;
}

async function getAccountOwner(unipileAccountId) {
    if (!unipileAccountId) return null;
    const cached = _accountOwnerCache.get(unipileAccountId);
    if (cached && cached.expires_at > Date.now()) return cached;

    try {
        const { default: supabase } = await import('./supabase.js');
        const { data } = await supabase
            .from('whatsapp_accounts')
            .select('connected_by_user_id, platform_users:connected_by_user_id(name)')
            .eq('unipile_account_id', unipileAccountId)
            .maybeSingle();

        const userId = data?.connected_by_user_id || null;
        const userName = data?.platform_users?.name || null;
        const entry = { user_id: userId, user_name: userName, expires_at: Date.now() + ACCOUNT_OWNER_TTL_MS };
        _accountOwnerCache.set(unipileAccountId, entry);
        return entry;
    } catch {
        return null;
    }
}

export function isAvailable() {
    return !!(API_KEY && DSN && ACCT_ID);
}

// ─── API Request ──────────────────────────────────────────────────────

async function req(endpoint, options = {}) {
    if (!isAvailable()) throw new Error('Unipile não configurado');
    const url  = `${BASE}${endpoint}`;
    const res  = await fetch(url, {
        ...options,
        headers: { 'X-API-KEY': API_KEY, 'Accept': 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Unipile (${res.status}): ${err}`);
    }
    return res.json();
}

// ─── Accounts ─────────────────────────────────────────────────────────

export async function listAccounts() {
    return req('/accounts');
}

export async function getWhatsAppAccountId() {
    if (ACCT_ID) return ACCT_ID;
    const result = await listAccounts();
    const wa = (result.items || result || []).find(a =>
        (a.type || a.provider || '').toUpperCase() === 'WHATSAPP'
    );
    return wa?.id || null;
}

// ─── Chats ────────────────────────────────────────────────────────────

export async function listChats({ limit = 30, cursor, unread } = {}) {
    let qs = `?account_type=WHATSAPP&limit=${limit}`;
    if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
    if (unread != null) qs += `&unread=${unread}`;
    return req(`/chats${qs}`);
}

export async function getChat(chatId) {
    return req(`/chats/${chatId}`);
}

export async function getChatAttendees(chatId) {
    return req(`/chats/${chatId}/attendees`);
}

// ─── Messages ─────────────────────────────────────────────────────────

export async function getMessages(chatId, { limit = 50, cursor } = {}) {
    let qs = `?limit=${limit}`;
    if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
    return req(`/chats/${chatId}/messages${qs}`);
}

export async function sendMessage(chatId, text, attachmentBuffer, attachmentName) {
    const fd = new FormData();
    if (text) fd.append('text', text);
    if (attachmentBuffer && attachmentName) {
        const blob = new Blob([attachmentBuffer]);
        fd.append('attachments', blob, attachmentName);
    }
    return req(`/chats/${chatId}/messages`, { method: 'POST', body: fd });
}

/**
 * Gera variantes BR de um número (com/sem 9, com/sem DDI 55).
 * Crítico em DDDs do Sul e antigos onde o WhatsApp do destinatário NÃO
 * tem o 9 inicial — mandar com 9 cai num chat fantasma que nunca entrega.
 */
function brPhoneVariants(phone) {
    const digits = String(phone).replace(/\D/g, '');
    const local = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
    const out = new Set();
    if (local.length >= 10) out.add(`55${local}`);                                      // como veio
    if (local.length === 10) out.add(`55${local.slice(0,2)}9${local.slice(2)}`);        // adiciona 9
    if (local.length === 11 && local[2] === '9') out.add(`55${local.slice(0,2)}${local.slice(3)}`); // remove 9
    return [...out];
}

/**
 * Procura um chat já existente nessa conta cujo attendee bata com qualquer
 * uma das variantes do telefone, com mensagens RECENTES delivered=1
 * (= número confirmadamente válido na rede WhatsApp).
 * Retorna { chat_id } ou null.
 */
async function findVerifiedChatByPhone(accountId, phoneVariants) {
    if (!accountId || !phoneVariants?.length) return null;
    try {
        const list = await req(`/chats?account_id=${accountId}&limit=100`);
        for (const chat of (list.items || [])) {
            const att = await req(`/chats/${chat.id}/attendees`).catch(() => null);
            const attendeePhones = (att?.items || [])
                .map(a => String(a.specifics?.phone_number || a.phone_number || a.public_identifier || '').replace(/\D/g, ''))
                .filter(Boolean);
            const matches = attendeePhones.some(p => phoneVariants.some(v => p.endsWith(v) || v.endsWith(p)));
            if (!matches) continue;

            // Confirma que o chat já teve msg outbound entregue (= número válido)
            const msgs = await req(`/chats/${chat.id}/messages?limit=10`).catch(() => null);
            const hasDelivered = (msgs?.items || []).some(m => m.is_sender && m.delivered === 1);
            if (hasDelivered) return { chat_id: chat.id };
        }
    } catch { /* fallback silencioso */ }
    return null;
}

/**
 * Inicia nova conversa pelo Unipile.
 * - Resolve a conta (com fallback se env stale)
 * - Procura chat já validado pra alguma variante do telefone (com/sem 9 BR);
 *   se achar, MANDA NELE em vez de criar duplicata fantasma
 * - Senão, cria chat novo com o phone como veio
 */
export async function startNewChat(phoneNumber, text, accountId = null) {
    let acct = accountId || await getWhatsAppAccountId();

    if (acct) {
        try {
            const r = await fetch(`${BASE}/accounts/${acct}`, {
                headers: { 'X-API-KEY': API_KEY }, signal: AbortSignal.timeout(4000),
            });
            if (!r.ok) acct = null;
        } catch { acct = null; }
    }
    if (!acct) {
        const all = await listAccounts().catch(() => null);
        const items = all?.items || [];
        const wa = items.find(a =>
            (a.type || a.provider || '').toUpperCase() === 'WHATSAPP'
            && Array.isArray(a.sources) && a.sources[0]?.status
            && /^(ok|connected|running|ok_for_now)$/i.test(a.sources[0].status)
        );
        acct = wa?.id || null;
    }
    if (!acct) throw new Error('Nenhuma conta WhatsApp conectada no Unipile');

    // Tenta achar um chat já confirmado (delivered=1 em msg anterior) pra alguma
    // variante do número. Evita o caso clássico do "5192924470 sem 9" sendo
    // mandado como "51992924470 com 9" → chat fantasma nunca entrega.
    const variants = brPhoneVariants(phoneNumber);
    const existing = await findVerifiedChatByPhone(acct, variants);
    if (existing?.chat_id) {
        await sendMessage(existing.chat_id, text);
        return { id: existing.chat_id, chat_id: existing.chat_id, reused_existing: true };
    }

    // Sem chat verificado existente — cria novo com o phone original
    const fd = new FormData();
    fd.append('account_id', acct);
    fd.append('text',       text);
    fd.append('attendees_ids', phoneNumber);
    return req('/chats', { method: 'POST', body: fd });
}

export function getAttachmentUrl(uri) {
    if (!uri || !isAvailable()) return null;
    const parts = uri.replace('att://', '').split('/');
    return `${BASE}/attachments/${parts.slice(1).join('/')}?X-API-KEY=${API_KEY}`;
}

// ─── Polling ──────────────────────────────────────────────────────────

export async function startPolling(intervalMs = 10_000) {
    if (!isAvailable()) {
        logger.warn('Unipile não configurado — polling desativado');
        return;
    }
    logger.info('WhatsApp polling iniciado', { interval_ms: intervalMs });

    async function poll() {
        try {
            const result = await listChats({ limit: 20 });
            const chats  = result.items || [];

            for (const chat of chats) {
                await processChat(chat);
            }
            _lastPollTime = Date.now();
        } catch (err) {
            logger.warn('Polling error', { error: err.message });
        }
    }

    await poll();
    _pollingInterval = setInterval(poll, intervalMs);
}

export function stopPolling() {
    if (_pollingInterval) clearInterval(_pollingInterval);
}

async function processChat(chat) {
    try {
        let conversation = await findConversationByChat(chat.id);
        let isNewConversation = false;

        if (!conversation) {
            isNewConversation = true;
            const attendees = (await getChatAttendees(chat.id)).items || [];
            const rawContact = attendees.find(a => !a.is_self);
            if (!rawContact) return;

            // Normalize via provider abstraction
            const contact = whatsapp.normalizeContact(rawContact);
            const phone = normalizePhone(contact.phone);
            let lead = phone ? await findLeadByPhone(phone) : null;

            if (!lead) {
                lead = await createLead({
                    name:   contact.name || phone || 'Desconhecido',
                    phone,
                    origin: 'whatsapp_direct',
                    origin_metadata: { attendee_id: contact.providerId },
                });
            }

            // Auto-match com Pipedrive (person + deals) — cascata conservadora:
            // (1) phone exato / variações BR
            // (2) nome exato do Unipile (só se match único)
            // (3) Apollo (opt-in via setting apollo_auto_match): descobre email/nome
            //     e tenta match por email no Pipedrive (único match)
            if (phone && !lead.crm_person_id) {
                try {
                    const matchResult = await smartMatchPipedrivePerson({
                        phone,
                        name: contact.name,
                    });

                    if (matchResult?.person) {
                        const pdPerson = matchResult.person;
                        const updates = {
                            crm_person_id: String(pdPerson.id),
                        };
                        if (!lead.name || lead.name === phone) updates.name = pdPerson.name;
                        if (!lead.company_name && pdPerson.org_name) updates.company_name = pdPerson.org_name;

                        const deals = await getDealsForPerson(pdPerson.id);
                        if (deals.length > 0) updates.crm_deal_id = String(deals[0].id);

                        await updateLead(lead.id, updates);
                        lead = { ...lead, ...updates };
                        logger.info('Auto-matched lead with Pipedrive', {
                            phone, person_id: pdPerson.id, deals: deals.length,
                            strategy: matchResult.strategy,
                        });
                    }
                } catch (err) {
                    logger.warn('Pipedrive auto-match failed', { phone, error: err.message });
                }
            }

            // Verifica quem iniciou a conversa: busca msgs para determinar
            // Se a primeira msg é outbound (nós iniciamos) → sem bot
            // Se é inbound (lead iniciou) → bot ativo apenas se veio do site (form)
            const initMsgs = await getMessages(chat.id, { limit: 5 });
            const initItems = initMsgs.items || [];
            // Ordena por timestamp (mais antiga primeiro)
            initItems.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            const firstMsg = initItems[0];
            const weStarted = firstMsg ? firstMsg.is_sender : false;

            // Se LLM disponível, ativa bot para TODOS os inbound (inclusive contatos diretos)
            // Sem LLM: só ativa para leads do site (origin=form)
            const botStage = weStarted ? 'human'
                : isLLMBotAvailable() ? 'qualifying'
                : (lead.origin === 'form' ? 'welcome' : 'human');

            // Tipo da conversa vem do default da conta WhatsApp.
            // Ex: número da Harylanne (5511999802791) é prospecting; outros 'inbound'.
            // Permite "pessoal SDR" vs "site oficial" coexistirem na mesma plataforma.
            let convType = 'inbound';
            if (chat.account_id) {
                try {
                    const { data: acc } = await import('./supabase.js').then(m =>
                        m.default
                            .from('whatsapp_accounts')
                            .select('default_conversation_type')
                            .eq('unipile_account_id', chat.account_id)
                            .maybeSingle()
                    );
                    if (acc?.default_conversation_type) convType = acc.default_conversation_type;
                } catch { /* fallback inbound */ }
            }

            conversation = await createConversation({
                lead_id:             lead.id,
                whatsapp_chat_id:    chat.id,
                whatsapp_account_id: chat.account_id || null,
                channel:             'whatsapp_direct',
                type:                convType,
                status:              weStarted ? 'in_progress' : 'waiting',
                chatbot_stage:       botStage,
                last_message_at:     new Date().toISOString(),
            });

            if (botStage === 'human') {
                logger.info('Bot desativado para conversa', { phone, reason: weStarted ? 'outbound' : 'direct_contact', origin: lead.origin });
            }
        }

        // Self-heal: backfill whatsapp_account_id em conversas antigas (antes da migration 005).
        // Roda uma vez por conversa — próxima passada do polling já não entra aqui.
        if (!isNewConversation && !conversation.whatsapp_account_id && chat.account_id) {
            await updateConversation(conversation.id, { whatsapp_account_id: chat.account_id });
            conversation.whatsapp_account_id = chat.account_id;
        }

        // Busca mensagens: conversa nova → importa histórico recente; existente → só desde último poll
        const fetchLimit = isNewConversation ? 50 : 10;
        const msgs  = await getMessages(chat.id, { limit: fetchLimit });
        const allMsgs = msgs.items || [];

        const newMsgs = isNewConversation
            ? allMsgs  // Conversa nova: importa todas as mensagens disponíveis
            : allMsgs.filter(m => new Date(m.timestamp) > new Date(_lastPollTime - 5_000));

        // Descobre quem é o dono da conta WhatsApp (pra gravar nome real em msgs outbound
        // que chegam pelo polling — ex: SDR enviando do celular, não da UI).
        // Cache simples em memória do chat.account_id → { user_id, user_name }.
        let accountOwner = null;
        const accountId = chat.account_id || conversation.whatsapp_account_id;
        if (accountId) {
            accountOwner = await getAccountOwner(accountId);
        }

        for (const rawMsg of newMsgs) {
            // Normalize via provider abstraction
            const msg = whatsapp.normalizeMessage(rawMsg);

            const isOutbound = msg.direction === 'outbound';
            const outboundName = accountOwner?.user_name || 'Atendente';
            const saved = await saveMessage({
                conversation_id:    conversation.id,
                direction:          msg.direction,
                sender_type:        isOutbound ? 'human' : 'lead',
                sender_name:        isOutbound ? outboundName : (conversation.leads?.name || 'Lead'),
                sent_by_user_id:    isOutbound ? (accountOwner?.user_id || null) : null,
                sent_by_name:       isOutbound ? outboundName : null,
                content:            msg.text,
                attachments:        msg.attachments,
                unipile_message_id: msg.id,
                created_at:         msg.timestamp,
                delivered:          !!msg.delivered,
                seen:               !!msg.seen,
            });

            // v2: Se saveMessage retorna null, mensagem é DUPLICATA. Mas se a msg
            // já existia, podemos atualizar delivered/seen (que mudam ao longo
            // do tempo conforme o destinatário recebe/lê).
            if (!saved) {
                if (isOutbound) {
                    const { default: sb } = await import('./supabase.js');
                    await sb
                        .from('messages')
                        .update({ delivered: !!msg.delivered, seen: !!msg.seen })
                        .eq('unipile_message_id', msg.id);
                }
                continue;
            }

            // v2: Reset bot_away_sent SOMENTE quando um humano respondeu (outbound humano)
            // Isso evita o loop: inbound → reset → away → inbound → reset → away...
            if (msg.direction === 'outbound' && saved.sender_type === 'human' && conversation.bot_away_sent) {
                await updateConversation(conversation.id, { bot_away_sent: false });
            }

            // Auto-create Reply activity in Pipedrive (fire and forget)
            if (msg.direction === 'inbound') {
                onInboundMessage(conversation.id).catch(() => {});
            }

            // Processa chatbot apenas para mensagens inbound
            if (msg.direction === 'inbound' && conversation.chatbot_stage !== 'human') {
                await processChatbotMessage(conversation, msg.text || '', chat.id, msg.attachments || []);
            }
        }

        if (newMsgs.length > 0) {
            await updateConversation(conversation.id, {
                last_message_at: new Date().toISOString(),
            });
        }
    } catch (err) {
        logger.warn('Erro ao processar chat', { chat_id: chat.id, error: err.message });
    }
}
