/**
 * Webhooks — Recebe leads do formulário do site
 * POST /api/webhook/form
 */
import { Router } from 'express';
import {
    createLead, createConversation, findLeadByPhone, normalizePhone
} from '../services/supabase.js';
import { startNewChat } from '../services/unipile.js';
import { queueLeadSync } from '../services/crm-sync.js';
import logger from '../services/logger.js';

const router = Router();

// ─── Webhook do formulário do site ────────────────────────────────────
router.post('/webhook/form', async (req, res) => {
    try {
        // Suporta múltiplos formatos (Typeform, RD Station, HTML form, etc.)
        const body = req.body || {};

        const name    = body.name || body.nome || body.full_name || body.Name || '';
        const email   = body.email || body.Email || '';
        const phone   = normalizePhone(body.phone || body.telefone || body.whatsapp || body.Phone || '');
        const company = body.company || body.empresa || body.company_name || '';
        const message = body.message || body.mensagem || body.description || '';

        // Origin metadata (UTMs, página, etc.)
        const origin_metadata = {
            utm_source:   body.utm_source   || body.UTM_SOURCE   || null,
            utm_medium:   body.utm_medium   || body.UTM_MEDIUM   || null,
            utm_campaign: body.utm_campaign || body.UTM_CAMPAIGN || null,
            page_url:     body.page_url     || body.url          || null,
            form_id:      body.form_id      || body.formId       || null,
            raw_message:  message || null,
            received_at:  new Date().toISOString(),
        };

        if (!phone && !email) {
            return res.status(400).json({ error: 'Pelo menos phone ou email é obrigatório' });
        }

        // Verifica se lead já existe (pelo telefone)
        let lead = phone ? await findLeadByPhone(phone) : null;

        if (!lead) {
            lead = await createLead({ name, phone, email, company_name: company, origin: 'form', origin_metadata });
            logger.info('Novo lead via formulário', { name, contact: phone || email });
        } else {
            logger.info('Lead existente encontrado', { name: lead.name, phone: lead.phone });
        }

        // Cria conversa no banco (sem chatId ainda — será vinculado quando o lead responder)
        const conversation = await createConversation({
            lead_id:  lead.id,
            channel:  'form',
            status:   'waiting',
            chatbot_stage: 'welcome', // Bot vai disparar a boas-vindas quando o lead contatar via WA
        });

        // Tenta iniciar conversa WhatsApp automaticamente se tem telefone
        let chatStarted = false;
        if (phone) {
            try {
                const waPhone = phone.startsWith('55') ? phone : `55${phone}`;
                const welcomeMsg =
                    `Olá${name ? `, ${name.split(' ')[0]}` : ''}! 👋 Recebemos seu contato através do site da *Branddi*.\n\n` +
                    `Para te direcionar ao time certo, me conta:\n\n` +
                    `1️⃣  Quero conhecer os serviços da Branddi\n` +
                    `2️⃣  Recebi uma notificação da Branddi\n` +
                    `3️⃣  Sou cliente e tenho uma dúvida`;

                const chatResult = await startNewChat(waPhone, welcomeMsg);
                const chatId = chatResult.chat_id || chatResult.id || chatResult.data?.id;

                if (chatId) {
                    // Atualiza conversa com chatId
                    const { updateConversation, saveMessage } = await import('../services/supabase.js');
                    await updateConversation(conversation.id, {
                        whatsapp_chat_id: chatId,
                        chatbot_stage: 'qualifying', // já enviou a pergunta
                    });
                    await saveMessage({
                        conversation_id: conversation.id,
                        direction: 'outbound',
                        sender_type: 'bot',
                        sender_name: 'Bot Branddi',
                        content: welcomeMsg,
                        unipile_message_id: `bot_form_${Date.now()}`,
                    });
                    chatStarted = true;
                }
            } catch (err) {
                logger.warn('Webhook: não foi possível iniciar chat WA', { error: err.message });
            }
        }

        // Enfileira sync com Pipedrive
        await queueLeadSync(lead.id, { origin: 'form', origin_metadata });

        res.json({
            success: true,
            lead_id: lead.id,
            conversation_id: conversation.id,
            whatsapp_started: chatStarted,
        });
    } catch (err) {
        logger.error('Webhook form error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── Webhook genérico (para testes / integrações futuras) ─────────────
router.post('/webhook/test', (req, res) => {
    logger.info('Webhook test received', { body: req.body });
    res.json({ received: true, body: req.body });
});

export default router;
