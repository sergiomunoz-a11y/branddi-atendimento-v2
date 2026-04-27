/**
 * Supabase Client — CRUD helpers para todas as tabelas
 * v2: Fix N+1 no inbox, settings via DB, dedup graceful, logger
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import logger from './logger.js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

export default supabase;

function sanitizeSearchTerm(term) {
    return String(term || '')
        .replace(/[\\%_]/g, '\\$&')
        .replace(/[(),`]/g, '')
        .slice(0, 200);
}

// ─── LEADS ────────────────────────────────────────────────────────────

export async function createLead(data) {
    const { data: lead, error } = await supabase
        .from('leads')
        .insert([{ ...data, updated_at: new Date().toISOString() }])
        .select()
        .single();
    if (error) throw error;
    return lead;
}

export async function findLeadByPhone(phone) {
    const normalized = normalizePhone(phone);
    const { data } = await supabase
        .from('leads')
        .select('*')
        .eq('phone', normalized)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
    return data || null;
}

export async function updateLead(id, updates) {
    const { data, error } = await supabase
        .from('leads')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function getLeads({ limit = 50, offset = 0, classification, origin, search } = {}) {
    let query = supabase
        .from('leads')
        .select('*, conversations(id, status, assigned_to, updated_at)')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (classification) query = query.eq('classification', classification);
    if (origin) query = query.eq('origin', origin);
    if (search) {
        const safe = sanitizeSearchTerm(search);
        query = query.or(`name.ilike.%${safe}%,company_name.ilike.%${safe}%,phone.ilike.%${safe}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

export async function getLeadById(id) {
    const { data, error } = await supabase
        .from('leads')
        .select('*, conversations(id, status, assigned_to, channel, created_at, updated_at)')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

// ─── CONVERSATIONS ────────────────────────────────────────────────────

export async function createConversation(data) {
    const { data: conv, error } = await supabase
        .from('conversations')
        .insert([{ ...data, updated_at: new Date().toISOString() }])
        .select()
        .single();
    if (error) throw error;
    return conv;
}

export async function getConversationById(id) {
    const { data, error } = await supabase
        .from('conversations')
        .select('*, leads(*)')
        .eq('id', id)
        .single();
    if (error) throw error;
    return data;
}

export async function findConversationByChat(whatsappChatId) {
    const { data } = await supabase
        .from('conversations')
        .select('*, leads(*)')
        .eq('whatsapp_chat_id', whatsappChatId)
        .single();
    return data || null;
}

export async function updateConversation(id, updates) {
    const { data, error } = await supabase
        .from('conversations')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

/**
 * getInbox — v2: busca apenas a última mensagem por conversa (fix N+1)
 * Usa subquery limitada em vez de trazer todas as mensagens.
 */
// Cache de metadata por account WhatsApp (60s).
// Estrutura: {
//   [unipile_account_id]: {
//     display_label: 'Ricardo' | null,         // sobrescreve nome real (SDR IA)
//     primary_owner_first_name: 'Harylanne' | null,  // do connected_by_user_id
//     permitted_users: [{ id, first_name }],   // users com o account em permissions
//   }
// }
let _accountOwnersCache = { data: null, ts: 0 };
async function getAccountOwnersMap() {
    const TTL = 60_000;
    if (_accountOwnersCache.data && (Date.now() - _accountOwnersCache.ts) < TTL) {
        return _accountOwnersCache.data;
    }
    try {
        const [accountsRes, usersRes] = await Promise.all([
            supabase
                .from('whatsapp_accounts')
                .select('unipile_account_id, display_label, connected_by_user_id, platform_users:connected_by_user_id(name)'),
            supabase
                .from('platform_users')
                .select('id, name, permissions')
                .eq('active', true),
        ]);
        const accounts = accountsRes.data || [];
        const users = usersRes.data || [];

        // Index reverso: account_id → users que têm permissão de operar
        const permittedByAccount = {};
        users.forEach(u => {
            const list = u.permissions?.whatsapp_accounts || [];
            list.forEach(accId => {
                permittedByAccount[accId] ||= [];
                permittedByAccount[accId].push({
                    id: u.id,
                    first_name: (u.name || '').split(/\s+/)[0] || u.name,
                });
            });
        });

        const map = {};
        accounts.forEach(a => {
            if (!a.unipile_account_id) return;
            const ownerName = a.platform_users?.name;
            map[a.unipile_account_id] = {
                display_label: a.display_label || null,
                primary_owner_first_name: ownerName ? ownerName.split(/\s+/)[0] : null,
                permitted_users: permittedByAccount[a.unipile_account_id] || [],
            };
        });
        _accountOwnersCache = { data: map, ts: Date.now() };
        return map;
    } catch {
        return _accountOwnersCache.data || {};
    }
}

/**
 * Decide quais nomes mostrar como etiqueta numa conversa.
 * Cascata:
 *   1. display_label da conta (SDR IA com label fixo: "Ricardo", "Gio")
 *   2. primary_owner_first_name (connected_by_user_id setado: 1 dono real)
 *   3. Se múltiplos users têm permissão e há mensagens humanas outbound
 *      com sent_by_user_id, retorna os nomes desses (interação real)
 *   4. Se 1 user permitido, retorna só ele
 *   5. Vazio
 */
function resolveOwnerNames(conv, accountMeta) {
    if (!accountMeta) return [];
    if (accountMeta.display_label) return [accountMeta.display_label];
    if (accountMeta.primary_owner_first_name) return [accountMeta.primary_owner_first_name];

    const permitted = accountMeta.permitted_users || [];
    if (permitted.length === 0) return [];
    if (permitted.length === 1) return [permitted[0].first_name];

    // Múltiplos donos compartilhando o número → mostra quem realmente
    // interagiu com este deal/conversa, baseado nas mensagens outbound humanas.
    const interactedIds = new Set();
    (conv.messages || []).forEach(m => {
        if (m.direction === 'outbound' && m.sender_type === 'human' && m.sent_by_user_id) {
            interactedIds.add(m.sent_by_user_id);
        }
    });
    const filtered = permitted.filter(u => interactedIds.has(u.id));
    return filtered.length > 0 ? filtered.map(u => u.first_name) : [];
}

export async function getInbox({
    status, assigned_to, limit = 50,
    type, role, user_id, allowed_types,
    allowed_accounts, // números WhatsApp que o não-Admin pode ver (permissions.whatsapp_accounts)
    filter_user_id, // Admin pode filtrar por usuário específico
    archived = false, // true = lista só arquivadas (Admin)
} = {}) {
    let query = supabase
        .from('conversations')
        .select(`
            *,
            leads(id, name, phone, company_name, classification, origin),
            messages(id, content, direction, sender_type, sender_name, sent_by_name, created_at, read_at)
        `)
        .neq('status', 'closed')
        .order('updated_at', { ascending: false })
        .order('created_at', { referencedTable: 'messages', ascending: false })
        .limit(limit);

    // Filtro de arquivadas (assume coluna archived_at; se não existir, Supabase ignora no select)
    if (archived) {
        query = query.not('archived_at', 'is', null);
    } else {
        query = query.is('archived_at', null);
    }

    if (status) query = query.eq('status', status);

    // Filtro por tipo de conversa
    if (type) {
        query = query.eq('type', type);
    } else if (allowed_types && allowed_types.length > 0) {
        query = query.in('type', allowed_types);
    }

    // Filtro por usuário: Admin vê tudo (com filtro opcional). Não-Admin vê só
    // conversas dos números WhatsApp atribuídos a ele em permissions.whatsapp_accounts.
    //
    // Quando Admin filtra por um usuário específico (filter_user_id), queremos ver
    // as conversas dos NÚMEROS vinculados àquele usuário (não assigned_user_id, que
    // é atribuição manual e quase nunca usada).
    if (role === 'Admin') {
        if (filter_user_id) {
            const { data: targetUser } = await supabase
                .from('platform_users')
                .select('permissions')
                .eq('id', filter_user_id)
                .maybeSingle();
            const targetAccounts = targetUser?.permissions?.whatsapp_accounts || [];
            if (targetAccounts.length === 0) {
                return []; // user não tem número atribuído
            }
            query = query.in('whatsapp_account_id', targetAccounts);
        }
        // Sem filter_user_id, Admin vê tudo
    } else {
        const accounts = Array.isArray(allowed_accounts) ? allowed_accounts : [];
        if (accounts.length === 0) {
            // Sem números atribuídos = inbox vazio (regra de negócio explícita)
            return [];
        }
        query = query.in('whatsapp_account_id', accounts);
    }

    if (assigned_to) {
        query = query.eq('assigned_to', assigned_to);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Hidrata cada conv com o primeiro nome do dono do número WhatsApp
    // (whatsapp_accounts.connected_by_user_id → platform_users.name).
    // Usa cache curto pra evitar query a cada chamada de getInbox.
    const accountOwners = await getAccountOwnersMap();

    return (data || []).map(conv => {
        const msgs = conv.messages || [];
        const accountMeta = accountOwners[conv.whatsapp_account_id] || null;
        const ownerNames = resolveOwnerNames(conv, accountMeta);
        return {
            ...conv,
            account_owner_name: ownerNames[0] || null,        // compat com versão anterior
            account_owner_names: ownerNames,                  // novo: 1+ tags
            last_message: msgs[0] || null,
            unread_count: msgs.filter(m =>
                m.direction === 'inbound' && !m.read_at
            ).length || 0,
            messages: undefined,
        };
    });
}

// ─── MESSAGES ─────────────────────────────────────────────────────────

/**
 * saveMessage — v2: retorna null se duplicata (em vez de throw)
 * Permite ao caller saber que a mensagem já existe e pular processamento.
 */
export async function saveMessage(data) {
    const { data: msg, error } = await supabase
        .from('messages')
        .upsert([data], { onConflict: 'unipile_message_id', ignoreDuplicates: true })
        .select()
        .single();
    if (error) {
        if (error.message?.includes('duplicate') || error.code === '23505') {
            return null;
        }
        // Se a coluna não existe, tenta novamente sem os campos opcionais
        if (error.code === '42703' || error.message?.includes('does not exist')) {
            const { sent_by_user_id, sent_by_name, ...safeData } = data;
            const retry = await supabase
                .from('messages')
                .upsert([safeData], { onConflict: 'unipile_message_id', ignoreDuplicates: true })
                .select()
                .single();
            if (retry.error) {
                if (retry.error.message?.includes('duplicate') || retry.error.code === '23505') return null;
                throw retry.error;
            }
            return retry.data;
        }
        throw error;
    }
    return msg;
}

export async function getMessages(conversationId, { limit = 50, before } = {}) {
    let query = supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(limit);

    if (before) query = query.lt('created_at', before);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

export async function markMessagesRead(conversationId) {
    await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('conversation_id', conversationId)
        .eq('direction', 'inbound')
        .is('read_at', null);
}

// ─── ROUTING EVENTS ───────────────────────────────────────────────────

export async function createRoutingEvent(data) {
    const { error } = await supabase
        .from('routing_events')
        .insert([data]);
    if (error) throw error;
}

// ─── CRM SYNC LOG ─────────────────────────────────────────────────────

export async function logCrmSync(data) {
    const { data: log, error } = await supabase
        .from('crm_sync_log')
        .insert([data])
        .select()
        .single();
    if (error) throw error;
    return log;
}

/**
 * getPendingSyncs — v2: também busca entries com retry pendente
 */
export async function getPendingSyncs(limit = 20) {
    const now = new Date().toISOString();
    const { data, error } = await supabase
        .from('crm_sync_log')
        .select('*')
        .or(`sync_status.eq.pending,and(sync_status.eq.error,retry_count.lt.3,next_retry_at.lte.${now})`)
        .order('synced_at', { ascending: true })
        .limit(limit);
    if (error) throw error;
    return data || [];
}

export async function updateSyncLog(id, updates) {
    await supabase
        .from('crm_sync_log')
        .update({ ...updates, synced_at: new Date().toISOString() })
        .eq('id', id);
}

// ─── SCRIPTS ──────────────────────────────────────────────────────────

export async function getScripts({ category, active = true } = {}) {
    let query = supabase
        .from('scripts')
        .select('*')
        .order('sort_order', { ascending: true });

    if (active) query = query.eq('is_active', true);
    if (category) query = query.eq('category', category);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

export async function upsertScript(data) {
    const { data: script, error } = await supabase
        .from('scripts')
        .upsert([{ ...data, updated_at: new Date().toISOString() }])
        .select()
        .single();
    if (error) throw error;
    return script;
}

// ─── DASHBOARD ────────────────────────────────────────────────────────

export async function getDashboardStats({ days = 30 } = {}) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [leadsRes, convRes, firstResponseRes] = await Promise.all([
        supabase.from('leads').select('id, origin, classification, created_at')
            .gte('created_at', since),
        supabase.from('conversations').select('id, status, assigned_to, channel, created_at')
            .gte('created_at', since),
        supabase.from('messages').select('conversation_id, created_at, direction')
            .gte('created_at', since).order('created_at', { ascending: true }),
    ]);

    const leads = leadsRes.data || [];
    const convs = convRes.data || [];

    const byOrigin = leads.reduce((acc, l) => {
        acc[l.origin] = (acc[l.origin] || 0) + 1;
        return acc;
    }, {});

    const byClassification = leads.reduce((acc, l) => {
        acc[l.classification] = (acc[l.classification] || 0) + 1;
        return acc;
    }, {});

    const byStatus = convs.reduce((acc, c) => {
        acc[c.status] = (acc[c.status] || 0) + 1;
        return acc;
    }, {});

    const leadsByDay = {};
    leads.forEach(l => {
        const day = l.created_at.split('T')[0];
        leadsByDay[day] = (leadsByDay[day] || 0) + 1;
    });

    return {
        totals: {
            leads: leads.length,
            conversations: convs.length,
            comercial: byClassification.comercial || 0,
            opec: byClassification.opec || 0,
            unclassified: byClassification.unclassified || 0,
        },
        byOrigin,
        byClassification,
        byStatus,
        leadsByDay,
        period_days: days,
    };
}

// ─── COMMERCIAL EVENTS (dashboard analytics) ─────────────────────────

/**
 * Loga um evento comercial pro dashboard analítico.
 * event_type: 'wa_activity_bb' | 'wa_activity_fr' | 'wa_activity_vm'
 *           | 'transcript_sent' | 'apollo_enrich_triggered' | 'apollo_enrich_matched'
 *           | 'outbound_started' | etc.
 * Non-blocking — falhas são silenciadas (não quebra o fluxo principal).
 */
export async function logCommercialEvent(event_type, ctx = {}) {
    try {
        await supabase.from('commercial_events').insert({
            event_type,
            user_id: ctx.user_id || null,
            conversation_id: ctx.conversation_id || null,
            lead_id: ctx.lead_id || null,
            whatsapp_account_id: ctx.whatsapp_account_id || null,
            metadata: ctx.metadata || null,
        });
    } catch { /* silently drop */ }
}

// ─── ANALYTICS DASHBOARD ─────────────────────────────────────────────

/**
 * Dashboard analítico com métricas por usuário, por número WhatsApp e agregados.
 * Role-aware: SDR vê só os próprios dados; Admin vê tudo e pode filtrar.
 */
export async function getAnalyticsDashboard({
    days = 30,
    user_id = null,         // Admin filtra por SDR; SDR é forçado a ele
    account_id = null,       // filtro por número WhatsApp
    type = null,             // 'inbound' | 'prospecting'
    role = 'Usuario',
    requester_id = null,
} = {}) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const effectiveUserId = role === 'Admin' ? user_id : requester_id;

    // Resolve lista de accounts que o filtro implica
    let accountsFilter = null;
    if (account_id) {
        accountsFilter = [account_id];
    } else if (effectiveUserId) {
        const { data: u } = await supabase
            .from('platform_users')
            .select('permissions')
            .eq('id', effectiveUserId)
            .maybeSingle();
        accountsFilter = u?.permissions?.whatsapp_accounts || [];
        if (accountsFilter.length === 0 && role !== 'Admin') {
            // SDR sem números vê zero
            return emptyAnalytics(days, since);
        }
    }

    // Query base de conversas pra resolver conversation_ids no escopo
    let convQuery = supabase
        .from('conversations')
        .select('id, whatsapp_account_id, type, status, created_at, lead_id')
        .gte('created_at', since);
    if (type) convQuery = convQuery.eq('type', type);
    if (accountsFilter && accountsFilter.length > 0) {
        convQuery = convQuery.in('whatsapp_account_id', accountsFilter);
    }
    const { data: convs = [] } = await convQuery;
    const convIds = convs.map(c => c.id);

    // Se scope é vazio, retorna zeros
    if (convIds.length === 0) {
        return emptyAnalytics(days, since);
    }

    // Mensagens no scope
    let msgQuery = supabase
        .from('messages')
        .select('id, conversation_id, direction, sender_type, sent_by_user_id, sent_by_name, created_at')
        .gte('created_at', since)
        .in('conversation_id', convIds)
        .limit(50000);
    const { data: msgs = [] } = await msgQuery;

    // Agrega envios / respostas
    let sent = 0, received = 0;
    const byDay = {}; // { YYYY-MM-DD: { sent, received } }
    const byUserAgg = {}; // { user_id: { sent, received, name, first_responses_ms: [], convs: Set } }
    const byAccountAgg = {}; // { account_id: { sent, received, convs: Set } }
    const convFirstOutboundBy = {}; // convId → { user_id, timestamp }
    const convFirstInboundAfter = {}; // convId → earliest inbound timestamp after first outbound

    const convMap = Object.fromEntries(convs.map(c => [c.id, c]));

    // Para detectar "1ª resposta": primeiro outbound humano, depois primeiro inbound após ele
    const sortedMsgs = [...msgs].sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const m of sortedMsgs) {
        const day = m.created_at.slice(0, 10);
        byDay[day] ||= { sent: 0, received: 0 };
        const conv = convMap[m.conversation_id];
        const accountId = conv?.whatsapp_account_id || null;

        if (m.direction === 'outbound' && m.sender_type === 'human') {
            sent++;
            byDay[day].sent++;
            if (accountId) {
                byAccountAgg[accountId] ||= { sent: 0, received: 0, convs: new Set() };
                byAccountAgg[accountId].sent++;
                byAccountAgg[accountId].convs.add(m.conversation_id);
            }
            if (m.sent_by_user_id) {
                byUserAgg[m.sent_by_user_id] ||= { sent: 0, received: 0, name: m.sent_by_name || null, first_responses_ms: [], convs: new Set() };
                byUserAgg[m.sent_by_user_id].sent++;
                byUserAgg[m.sent_by_user_id].convs.add(m.conversation_id);
            }
            // Primeiro outbound da conversa define o "dono" pra medir tempo de resposta
            if (!convFirstOutboundBy[m.conversation_id]) {
                convFirstOutboundBy[m.conversation_id] = {
                    user_id: m.sent_by_user_id || null,
                    ts: m.created_at,
                };
            }
        } else if (m.direction === 'inbound') {
            received++;
            byDay[day].received++;
            if (accountId) {
                byAccountAgg[accountId] ||= { sent: 0, received: 0, convs: new Set() };
                byAccountAgg[accountId].received++;
            }
            // Atribui recepção ao user que fez o primeiro outbound daquela conversa
            const firstOut = convFirstOutboundBy[m.conversation_id];
            if (firstOut?.user_id) {
                byUserAgg[firstOut.user_id].received++;
                // 1ª resposta (só a primeira depois do outbound)
                if (!convFirstInboundAfter[m.conversation_id]) {
                    convFirstInboundAfter[m.conversation_id] = m.created_at;
                    const delta = new Date(m.created_at) - new Date(firstOut.ts);
                    if (delta > 0 && delta < 7 * 86400 * 1000) { // ignora outliers > 7d
                        byUserAgg[firstOut.user_id].first_responses_ms.push(delta);
                    }
                }
            }
        }
    }

    // Tempo médio de 1ª resposta global
    const allFirstMs = Object.values(byUserAgg).flatMap(u => u.first_responses_ms);
    const avgFirstResponseMs = allFirstMs.length > 0
        ? Math.round(allFirstMs.reduce((s, v) => s + v, 0) / allFirstMs.length)
        : null;

    // Hidrata nomes dos users a partir de platform_users
    const userIds = Object.keys(byUserAgg);
    let userMap = {};
    if (userIds.length > 0) {
        const { data: users = [] } = await supabase
            .from('platform_users')
            .select('id, name, permissions')
            .in('id', userIds);
        userMap = Object.fromEntries(users.map(u => [u.id, u]));
    }

    const byUser = userIds.map(uid => {
        const agg = byUserAgg[uid];
        const firstMsAvg = agg.first_responses_ms.length > 0
            ? Math.round(agg.first_responses_ms.reduce((s, v) => s + v, 0) / agg.first_responses_ms.length)
            : null;
        return {
            user_id: uid,
            name: userMap[uid]?.name || agg.name || '—',
            phone_numbers: userMap[uid]?.permissions?.whatsapp_accounts || [],
            sent: agg.sent,
            received: agg.received,
            reply_rate: agg.sent > 0 ? agg.received / agg.sent : null,
            conversations: agg.convs.size,
            avg_first_response_ms: firstMsAvg,
        };
    }).sort((a, b) => b.sent - a.sent);

    // Hidrata phone dos accounts
    const accountIds = Object.keys(byAccountAgg);
    let accountMap = {};
    if (accountIds.length > 0) {
        const { data: accounts = [] } = await supabase
            .from('whatsapp_accounts')
            .select('unipile_account_id, phone_number, connected_by_user_id, platform_users:connected_by_user_id(name)')
            .in('unipile_account_id', accountIds);
        accountMap = Object.fromEntries(accounts.map(a => [a.unipile_account_id, a]));
    }

    const byAccount = accountIds.map(aid => {
        const agg = byAccountAgg[aid];
        return {
            account_id: aid,
            phone: accountMap[aid]?.phone_number || '—',
            owner_name: accountMap[aid]?.platform_users?.name || null,
            sent: agg.sent,
            received: agg.received,
            conversations: agg.convs.size,
            reply_rate: agg.sent > 0 ? agg.received / agg.sent : null,
        };
    }).sort((a, b) => b.sent - a.sent);

    // Eventos comerciais (atividades manuais, Apollo, etc.)
    let eventsQuery = supabase
        .from('commercial_events')
        .select('event_type, user_id, conversation_id, whatsapp_account_id, created_at')
        .gte('created_at', since)
        .limit(50000);
    if (effectiveUserId) eventsQuery = eventsQuery.eq('user_id', effectiveUserId);
    if (accountsFilter && accountsFilter.length > 0) {
        eventsQuery = eventsQuery.in('whatsapp_account_id', accountsFilter);
    }
    const { data: events = [] } = await eventsQuery;
    const eventsByType = events.reduce((acc, e) => {
        acc[e.event_type] = (acc[e.event_type] || 0) + 1;
        return acc;
    }, {});

    // Apollo enrichments (da tabela específica)
    let apolloQuery = supabase
        .from('apollo_enrichments')
        .select('status, phone, user_id')
        .gte('created_at', since);
    if (effectiveUserId) apolloQuery = apolloQuery.eq('user_id', effectiveUserId);
    const { data: apolloRows = [] } = await apolloQuery;
    const apollo = {
        triggered: apolloRows.length,
        completed: apolloRows.filter(r => r.status === 'completed').length,
        matched_with_phone: apolloRows.filter(r => r.status === 'completed' && r.phone).length,
        not_found: apolloRows.filter(r => r.status === 'not_found').length,
    };

    // Leads breakdown (para manter KPIs existentes)
    let leadsQuery = supabase
        .from('leads')
        .select('id, origin, classification, created_at')
        .gte('created_at', since);
    const { data: leads = [] } = await leadsQuery;
    const byOrigin = {}, byClassification = {};
    leads.forEach(l => {
        byOrigin[l.origin] = (byOrigin[l.origin] || 0) + 1;
        byClassification[l.classification] = (byClassification[l.classification] || 0) + 1;
    });

    return {
        period: { days, since },
        scope: {
            role,
            user_id: effectiveUserId,
            account_id,
            type,
        },
        totals: {
            leads: leads.length,
            conversations: convs.length,
            comercial: byClassification.comercial || 0,
            opec: byClassification.opec || 0,
            unclassified: byClassification.unclassified || 0,
        },
        messages: {
            sent,
            received,
            reply_rate: sent > 0 ? received / sent : null,
            avg_first_response_ms: avgFirstResponseMs,
        },
        byDay: Object.entries(byDay)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, v]) => ({ date, sent: v.sent, received: v.received })),
        byUser: role === 'Admin' ? byUser : byUser.filter(u => u.user_id === effectiveUserId),
        byAccount,
        activities: {
            wa_bb: eventsByType.wa_activity_bb || 0,
            wa_fr: eventsByType.wa_activity_fr || 0,
            wa_vm: eventsByType.wa_activity_vm || 0,
            transcripts: eventsByType.transcript_sent || 0,
            total_manual:
                (eventsByType.wa_activity_bb || 0) +
                (eventsByType.wa_activity_fr || 0) +
                (eventsByType.wa_activity_vm || 0),
        },
        apollo,
        byOrigin,
        byClassification,
    };
}

function emptyAnalytics(days, since) {
    return {
        period: { days, since },
        scope: { role: 'Usuario', user_id: null, account_id: null, type: null },
        totals: { leads: 0, conversations: 0, comercial: 0, opec: 0, unclassified: 0 },
        messages: { sent: 0, received: 0, reply_rate: null, avg_first_response_ms: null },
        byDay: [],
        byUser: [],
        byAccount: [],
        activities: { wa_bb: 0, wa_fr: 0, wa_vm: 0, transcripts: 0, total_manual: 0 },
        apollo: { triggered: 0, completed: 0, matched_with_phone: 0, not_found: 0 },
        byOrigin: {},
        byClassification: {},
    };
}

// ─── SETTINGS (via platform_settings table) ──────────────────────────

export async function getSettingValue(key, defaultValue = null) {
    const { data } = await supabase
        .from('platform_settings')
        .select('value')
        .eq('setting_key', key)
        .single();
    return data?.value ?? defaultValue;
}

export async function saveSetting(key, value) {
    const { data, error } = await supabase
        .from('platform_settings')
        .upsert(
            { setting_key: key, value, updated_at: new Date().toISOString() },
            { onConflict: 'setting_key' }
        )
        .select()
        .single();
    if (error) throw error;
    return data;
}

export async function getAllSettings() {
    const { data } = await supabase
        .from('platform_settings')
        .select('*');
    return (data || []).map(s => ({ ...s, key: s.setting_key }));
}

/** Retorna settings como objeto key→value (usado por routes/settings.js) */
export async function getSettings() {
    const rows = await getAllSettings();
    const obj = {};
    for (const row of rows) {
        obj[row.key] = row.value;
    }
    return obj;
}

// ─── UTILS ────────────────────────────────────────────────────────────

export function normalizePhone(phone) {
    if (!phone) return '';
    let digits = String(phone).replace(/\D/g, '');

    // Remove country code 55
    if (digits.startsWith('55') && digits.length >= 12) digits = digits.slice(2);

    // Celular BR sem 9° dígito: DDD(2) + 8 dígitos = 10 → insere 9
    if (digits.length === 10) {
        const ddd = digits.slice(0, 2);
        const num = digits.slice(2);
        digits = `${ddd}9${num}`;
    }

    return digits;
}

// ─── BOT 24H — Conversas sem resposta humana ──────────────────────────

export async function getConversationsWaitingForHuman(cutoffIso) {
    const { data, error } = await supabase
        .from('conversations')
        .select('id, whatsapp_chat_id, chatbot_stage, bot_away_sent, updated_at, leads!inner(name, origin)')
        .in('status', ['waiting', 'in_progress'])
        .eq('chatbot_stage', 'human')
        .neq('leads.origin', 'pipedrive_outbound')
        .or('bot_away_sent.is.null,bot_away_sent.eq.false')
        .lt('updated_at', cutoffIso)
        .limit(20);

    if (error) {
        logger.warn('getConversationsWaitingForHuman error', { error: error.message });
        return [];
    }
    return data || [];
}

// ─── HISTÓRICO DE CONVERSAS ───────────────────────────────────────────

export async function getConversationHistory({
    limit = 50, offset = 0, status, classification, origin, search, days
} = {}) {
    let query = supabase
        .from('conversations')
        .select(`
            id, status, assigned_to, channel, chatbot_stage, created_at, updated_at,
            leads(id, name, phone, company_name, classification, origin, crm_deal_id)
        `)
        .order('updated_at', { ascending: false })
        .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (days) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        query = query.gte('created_at', since);
    }
    if (classification) query = query.eq('leads.classification', classification);
    if (origin) query = query.eq('channel', origin);
    if (search) {
        const safe = sanitizeSearchTerm(search);
        query = query.or(`leads.name.ilike.%${safe}%,leads.company_name.ilike.%${safe}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}
