/**
 * Auto Activities — Cria atividades no Pipedrive automaticamente
 *
 * - WhatsApp activity: quando msg outbound é enviada (1x por conversa/dia)
 * - Resposta activity: quando msg inbound é recebida (1x por conversa/dia)
 * - Dedup via campos last_wa_activity_date e last_reply_activity_date na tabela conversations
 */
import supabase from './supabase.js';
import { getLeadById } from './supabase.js';
import { createWhatsAppActivity, createReplyActivity } from './pipedrive.js';
import logger from './logger.js';

/**
 * Resolve o token Pipedrive individual do usuário (ou fallback global)
 */
async function getUserPipedriveToken(userId) {
    if (!userId) return process.env.PIPEDRIVE_API_TOKEN;
    try {
        const { data } = await supabase
            .from('platform_users')
            .select('pipedrive_api_token, pipedrive_user_id')
            .eq('id', userId)
            .single();
        return {
            token: data?.pipedrive_api_token || process.env.PIPEDRIVE_API_TOKEN,
            pipedriveUserId: data?.pipedrive_user_id || null,
        };
    } catch {
        return { token: process.env.PIPEDRIVE_API_TOKEN, pipedriveUserId: null };
    }
}

/**
 * Busca deal_id, person_id e type do lead vinculado à conversa
 */
async function getConversationDealInfo(conversationId) {
    try {
        const { data: conv } = await supabase
            .from('conversations')
            .select('lead_id, type, whatsapp_account_id, last_wa_activity_date, last_reply_activity_date')
            .eq('id', conversationId)
            .single();
        if (!conv?.lead_id) return null;

        const lead = await getLeadById(conv.lead_id);
        if (!lead?.crm_deal_id) return null;

        return {
            dealId: lead.crm_deal_id,
            personId: lead.crm_person_id || null,
            leadName: lead.name || lead.phone || 'Lead',
            conversationType: conv.type || null,
            whatsappAccountId: conv.whatsapp_account_id || null,
            lastWaDate: conv.last_wa_activity_date,
            lastReplyDate: conv.last_reply_activity_date,
        };
    } catch {
        return null;
    }
}

/**
 * Descobre o token Pipedrive do dono da conta WhatsApp por onde veio a conversa.
 * Assim atividades ficam no nome do SDR certo (não do token global).
 * Fallback: token global.
 */
async function getTokenByWhatsAppAccount(unipileAccountId) {
    if (!unipileAccountId) return process.env.PIPEDRIVE_API_TOKEN;
    try {
        const { data } = await supabase
            .from('whatsapp_accounts')
            .select('connected_by_user_id, platform_users:connected_by_user_id(pipedrive_api_token)')
            .eq('unipile_account_id', unipileAccountId)
            .maybeSingle();
        const personalToken = data?.platform_users?.pipedrive_api_token;
        return personalToken || process.env.PIPEDRIVE_API_TOKEN;
    } catch {
        return process.env.PIPEDRIVE_API_TOKEN;
    }
}

/**
 * Chamado quando uma mensagem OUTBOUND é enviada (humano → lead)
 * Cria atividade tipo "whatsapp" no Pipedrive (1x por conversa/dia)
 */
export async function onOutboundMessage(conversationId, userId) {
    try {
        const info = await getConversationDealInfo(conversationId);
        if (!info) return; // sem deal vinculado, ignora

        // Leads de prospecção: atividade WhatsApp é criada MANUALMENTE pelo SDR
        // via os botões BB/FR/VM no painel direito — não criamos automática.
        if (info.conversationType === 'prospecting') return;

        const today = new Date().toISOString().split('T')[0];
        if (info.lastWaDate === today) return; // já criou hoje

        // ATOMIC CLAIM — pra hoje. Reivindica se NULL ou se data anterior.
        const { data: claimed, error: claimErr } = await supabase
            .from('conversations')
            .update({ last_wa_activity_date: today })
            .eq('id', conversationId)
            .or(`last_wa_activity_date.is.null,last_wa_activity_date.lt.${today}`)
            .select('id')
            .maybeSingle();
        if (claimErr || !claimed) return;

        // Prioridade: (1) token do user logado na UI, (2) token do dono da conta
        // WhatsApp (SDR enviou do celular direto), (3) token global.
        let token, pipedriveUserId = null;
        if (userId) {
            const r = await getUserPipedriveToken(userId);
            token = r?.token;
            pipedriveUserId = r?.pipedriveUserId || null;
        }
        if (!token) {
            token = await getTokenByWhatsAppAccount(info.whatsappAccountId);
        }

        try {
            await createWhatsAppActivity({
                dealId: info.dealId,
                personId: info.personId,
                subject: `WhatsApp — ${info.leadName}`,
                transcript: '',
                done: true,
                tokenOverride: token,
            });
        } catch (err) {
            // Falha → reverte claim para tentar amanhã
            await supabase
                .from('conversations')
                .update({ last_wa_activity_date: info.lastWaDate || null })
                .eq('id', conversationId);
            throw err;
        }

        logger.info('Auto WhatsApp activity created', {
            conversation_id: conversationId,
            deal_id: info.dealId,
        });
    } catch (err) {
        logger.warn('Auto WhatsApp activity error', {
            conversation_id: conversationId,
            error: err.message,
        });
    }
}

/**
 * Chamado quando uma mensagem INBOUND é recebida (lead → humano)
 * Cria atividade tipo "resposta" no Pipedrive — APENAS UMA POR CONVERSA, ever.
 *
 * "1 conversa = 1 sinal de que o lead respondeu". Não importa quantas mensagens
 * inbound vierem ao longo dos dias — a primeira já gerou a atividade.
 *
 * Usa atomic compare-and-swap (UPDATE WHERE IS NULL + RETURNING) para evitar
 * race condition: várias mensagens inbound chegando ao mesmo tempo competem
 * pelo claim, mas só uma vence e cria a atividade.
 */
export async function onInboundMessage(conversationId) {
    try {
        const info = await getConversationDealInfo(conversationId);
        if (!info) return; // sem deal vinculado, ignora

        // Já criada nessa conversa em algum momento → não duplica
        if (info.lastReplyDate) return;

        // ATOMIC CLAIM — só uma chamada concorrente consegue marcar a coluna
        const today = new Date().toISOString().split('T')[0];
        const { data: claimed, error: claimErr } = await supabase
            .from('conversations')
            .update({ last_reply_activity_date: today })
            .eq('id', conversationId)
            .is('last_reply_activity_date', null)
            .select('id')
            .maybeSingle();

        if (claimErr || !claimed) {
            // Outro processo já reivindicou — não cria
            return;
        }

        // Token pessoal do dono da conta WhatsApp (atividade no nome certo)
        const replyToken = await getTokenByWhatsAppAccount(info.whatsappAccountId);

        try {
            await createReplyActivity({
                dealId: info.dealId,
                personId: info.personId,
                subject: `Resposta recebida — ${info.leadName}`,
                content: `Lead respondeu via WhatsApp em ${new Date().toLocaleDateString('pt-BR')}`,
                tokenOverride: replyToken,
            });
        } catch (err) {
            // Falha na criação → libera o claim pra próxima tentativa
            await supabase
                .from('conversations')
                .update({ last_reply_activity_date: null })
                .eq('id', conversationId);
            throw err;
        }

        logger.info('Auto Reply activity created', {
            conversation_id: conversationId,
            deal_id: info.dealId,
        });
    } catch (err) {
        logger.warn('Auto Reply activity error', {
            conversation_id: conversationId,
            error: err.message,
        });
    }
}
