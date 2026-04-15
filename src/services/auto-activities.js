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
 * Busca deal_id e person_id do lead vinculado à conversa
 */
async function getConversationDealInfo(conversationId) {
    try {
        const { data: conv } = await supabase
            .from('conversations')
            .select('lead_id, last_wa_activity_date, last_reply_activity_date')
            .eq('id', conversationId)
            .single();
        if (!conv?.lead_id) return null;

        const lead = await getLeadById(conv.lead_id);
        if (!lead?.crm_deal_id) return null;

        return {
            dealId: lead.crm_deal_id,
            personId: lead.crm_person_id || null,
            leadName: lead.name || lead.phone || 'Lead',
            lastWaDate: conv.last_wa_activity_date,
            lastReplyDate: conv.last_reply_activity_date,
        };
    } catch {
        return null;
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

        const today = new Date().toISOString().split('T')[0];
        if (info.lastWaDate === today) return; // já criou hoje

        const { token, pipedriveUserId } = await getUserPipedriveToken(userId);

        await createWhatsAppActivity({
            dealId: info.dealId,
            personId: info.personId,
            subject: `WhatsApp — ${info.leadName}`,
            transcript: '', // atividade simples, sem transcrição
            done: true,
            tokenOverride: token,
        });

        // Marca que já criou atividade WhatsApp hoje para esta conversa
        await supabase
            .from('conversations')
            .update({ last_wa_activity_date: today })
            .eq('id', conversationId);

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
 * Cria atividade tipo "resposta" no Pipedrive (1x por conversa/dia)
 */
export async function onInboundMessage(conversationId) {
    try {
        const info = await getConversationDealInfo(conversationId);
        if (!info) return; // sem deal vinculado, ignora

        const today = new Date().toISOString().split('T')[0];
        if (info.lastReplyDate === today) return; // já criou hoje

        await createReplyActivity({
            dealId: info.dealId,
            personId: info.personId,
            subject: `Resposta recebida — ${info.leadName}`,
            content: `Lead respondeu via WhatsApp em ${new Date().toLocaleDateString('pt-BR')}`,
            tokenOverride: process.env.PIPEDRIVE_API_TOKEN, // resposta usa token global
        });

        // Marca que já criou atividade de resposta hoje para esta conversa
        await supabase
            .from('conversations')
            .update({ last_reply_activity_date: today })
            .eq('id', conversationId);

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
