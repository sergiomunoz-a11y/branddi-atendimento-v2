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
import { findPersonByPhone, getDealsForPerson } from './pipedrive.js';
import whatsapp from '../providers/index.js';
import logger from './logger.js';

// ─── Config ───────────────────────────────────────────────────────────
const API_KEY = process.env.UNIPILE_API_KEY;
const DSN     = process.env.UNIPILE_DSN;
const ACCT_ID = process.env.UNIPILE_ACCOUNT_ID;
const BASE    = DSN ? `https://${DSN}/api/v1` : null;

let _pollingInterval = null;
let _lastPollTime    = Date.now() - 60_000;

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

export async function startNewChat(phoneNumber, text) {
    const accountId = await getWhatsAppAccountId();
    if (!accountId) throw new Error('Nenhuma conta WhatsApp conectada no Unipile');
    const fd = new FormData();
    fd.append('account_id', accountId);
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

            // Auto-match com Pipedrive (person + deals)
            if (phone && !lead.crm_person_id) {
                try {
                    const pdPerson = await findPersonByPhone(phone);
                    if (pdPerson) {
                        const updates = {
                            crm_person_id: String(pdPerson.id),
                        };
                        if (!lead.name || lead.name === phone) updates.name = pdPerson.name;
                        if (!lead.company_name && pdPerson.org_name) updates.company_name = pdPerson.org_name;

                        const deals = await getDealsForPerson(pdPerson.id);
                        if (deals.length > 0) updates.crm_deal_id = String(deals[0].id);

                        await updateLead(lead.id, updates);
                        lead = { ...lead, ...updates };
                        logger.info('Auto-matched lead with Pipedrive', { phone, person_id: pdPerson.id, deals: deals.length });
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

            conversation = await createConversation({
                lead_id:             lead.id,
                whatsapp_chat_id:    chat.id,
                whatsapp_account_id: chat.account_id || null,
                channel:             'whatsapp_direct',
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

        for (const rawMsg of newMsgs) {
            // Normalize via provider abstraction
            const msg = whatsapp.normalizeMessage(rawMsg);

            const saved = await saveMessage({
                conversation_id:    conversation.id,
                direction:          msg.direction,
                sender_type:        msg.direction === 'outbound' ? 'human' : 'lead',
                sender_name:        msg.direction === 'outbound' ? 'Atendente' : conversation.leads?.name || 'Lead',
                content:            msg.text,
                attachments:        msg.attachments,
                unipile_message_id: msg.id,
                created_at:         msg.timestamp,
            });

            // v2: Se saveMessage retorna null, mensagem é duplicata — pula processamento
            if (!saved) continue;

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
