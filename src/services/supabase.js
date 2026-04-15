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
export async function getInbox({
    status, assigned_to, limit = 50,
    type, role, user_id, allowed_types,
    filter_user_id, // Admin pode filtrar por usuário específico
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

    if (status) query = query.eq('status', status);

    // Filtro por tipo de conversa
    if (type) {
        query = query.eq('type', type);
    } else if (allowed_types && allowed_types.length > 0) {
        query = query.in('type', allowed_types);
    }

    // Filtro por usuário: Admin vê tudo (com filtro opcional), demais só as próprias
    if (role === 'Admin') {
        if (filter_user_id) {
            query = query.eq('assigned_user_id', filter_user_id);
        }
        // Sem filter_user_id, Admin vê tudo
    } else if (user_id) {
        // Não-Admin: só conversas atribuídas a ele
        query = query.eq('assigned_user_id', user_id);
    }

    if (assigned_to) {
        query = query.eq('assigned_to', assigned_to);
    }

    const { data, error } = await query;
    if (error) throw error;

    return (data || []).map(conv => {
        const msgs = conv.messages || [];
        return {
            ...conv,
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
        .select('id, whatsapp_chat_id, chatbot_stage, bot_away_sent, updated_at, leads(name)')
        .in('status', ['waiting', 'in_progress'])
        .eq('chatbot_stage', 'human')
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
