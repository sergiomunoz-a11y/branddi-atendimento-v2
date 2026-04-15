/**
 * Messages Routes — Envio/recebimento e histórico de mensagens
 */
import { Router } from 'express';
import { getMessages, saveMessage, markMessagesRead, updateConversation, getLeadById } from '../services/supabase.js';
import { sendMessage, startNewChat } from '../services/unipile.js';
import { applyScriptVariables } from '../services/chatbot-engine.js';
import supabase from '../services/supabase.js';

const router = Router();

// ─── GET /api/messages/:conversationId — Histórico ────────────────────
router.get('/messages/:conversationId', async (req, res) => {
    try {
        const { limit = 50, before } = req.query;
        const messages = await getMessages(req.params.conversationId, {
            limit: parseInt(limit), before,
        });

        // Marca como lidas
        await markMessagesRead(req.params.conversationId).catch(() => {});

        res.json({ messages, total: messages.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/messages/:conversationId/send — Envia mensagem humana ──
router.post('/messages/:conversationId/send', async (req, res) => {
    try {
        const { text } = req.body;
        let { chatId } = req.body;
        if (!text) return res.status(400).json({ error: 'text é obrigatório' });

        // Se conversa não tem chatId (outbound novo), inicia chat via Unipile
        if (!chatId) {
            // Busca conversa e lead para pegar o telefone
            const { data: conv } = await supabase
                .from('conversations')
                .select('id, lead_id, whatsapp_chat_id')
                .eq('id', req.params.conversationId)
                .single();

            if (conv?.whatsapp_chat_id) {
                chatId = conv.whatsapp_chat_id;
            } else if (conv?.lead_id) {
                const lead = await getLeadById(conv.lead_id);
                if (lead?.phone) {
                    const whatsappPhone = lead.phone.startsWith('55') ? lead.phone : `55${lead.phone}`;
                    const chatResult = await startNewChat(whatsappPhone, text);
                    chatId = chatResult?.id || chatResult?.chat_id;
                    if (chatId) {
                        await updateConversation(req.params.conversationId, { whatsapp_chat_id: chatId });
                    }

                    // Primeira msg já foi enviada pelo startNewChat, salvar e retornar
                    const msg = await saveMessage({
                        conversation_id:   req.params.conversationId,
                        direction:         'outbound',
                        sender_type:       'human',
                        sender_name:       req.user?.name || 'Atendente',
                        sent_by_user_id:   req.user?.id || null,
                        sent_by_name:      req.user?.name || null,
                        content:           text,
                        attachments:       [],
                        unipile_message_id: `human_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                    });
                    await updateConversation(req.params.conversationId, {
                        chatbot_stage: 'human', status: 'in_progress',
                        last_message_at: new Date().toISOString(),
                    });
                    return res.json({ success: true, message: msg, chat_started: true });
                }
            }
            if (!chatId) return res.status(400).json({ error: 'Sem chatId e sem telefone para iniciar conversa' });
        }

        // Envia via Unipile
        await sendMessage(chatId, text);

        // Salva no banco com rastreio do remetente
        const msg = await saveMessage({
            conversation_id:   req.params.conversationId,
            direction:         'outbound',
            sender_type:       'human',
            sender_name:       req.user?.name || 'Atendente',
            sent_by_user_id:   req.user?.id || null,
            sent_by_name:      req.user?.name || null,
            content:           text,
            attachments:       [],
            unipile_message_id: `human_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });

        // Garante que a conversa está em modo humano
        await updateConversation(req.params.conversationId, {
            chatbot_stage: 'human',
            status: 'in_progress',
            last_message_at: new Date().toISOString(),
        });

        res.json({ success: true, message: msg });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/messages/:conversationId/script — Aplica script ────────
router.post('/messages/:conversationId/script', async (req, res) => {
    try {
        const { script_content, chatId, lead_id } = req.body;
        if (!script_content) return res.status(400).json({ error: 'script_content é obrigatório' });
        if (!chatId) return res.status(400).json({ error: 'chatId é obrigatório' });

        // Busca lead para aplicar variáveis
        let lead = null;
        if (lead_id) {
            lead = await getLeadById(lead_id).catch(() => null);
        }

        // Aplica variáveis no script
        const text = applyScriptVariables(script_content, lead);

        // Envia via Unipile
        await sendMessage(chatId, text);

        // Salva no banco com rastreio do remetente
        const msg = await saveMessage({
            conversation_id:   req.params.conversationId,
            direction:         'outbound',
            sender_type:       'human',
            sender_name:       req.user?.name || 'Atendente',
            sent_by_user_id:   req.user?.id || null,
            sent_by_name:      req.user?.name || null,
            content:           text,
            attachments:       [],
            unipile_message_id: `script_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });

        await updateConversation(req.params.conversationId, {
            chatbot_stage: 'human',
            status: 'in_progress',
            last_message_at: new Date().toISOString(),
        });

        res.json({ success: true, message: msg, applied_text: text });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
