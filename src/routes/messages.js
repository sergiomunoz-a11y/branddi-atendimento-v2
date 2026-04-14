/**
 * Messages Routes — Envio/recebimento e histórico de mensagens
 */
import { Router } from 'express';
import { getMessages, saveMessage, markMessagesRead, updateConversation } from '../services/supabase.js';
import { sendMessage } from '../services/unipile.js';
import { applyScriptVariables } from '../services/chatbot-engine.js';
import { getLeadById } from '../services/supabase.js';

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
        const { text, chatId } = req.body;
        if (!text) return res.status(400).json({ error: 'text é obrigatório' });
        if (!chatId) return res.status(400).json({ error: 'chatId é obrigatório' });

        // Envia via Unipile
        await sendMessage(chatId, text);

        // Salva no banco
        const msg = await saveMessage({
            conversation_id:   req.params.conversationId,
            direction:         'outbound',
            sender_type:       'human',
            sender_name:       'Atendente',
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

        // Salva no banco
        const msg = await saveMessage({
            conversation_id:   req.params.conversationId,
            direction:         'outbound',
            sender_type:       'human',
            sender_name:       'Atendente',
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
