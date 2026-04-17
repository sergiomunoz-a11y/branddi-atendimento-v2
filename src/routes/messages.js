/**
 * Messages Routes — Envio/recebimento e histórico de mensagens
 */
import { Router } from 'express';
import multer from 'multer';
import { getMessages, saveMessage, markMessagesRead, updateConversation, getLeadById } from '../services/supabase.js';
import { sendMessage, startNewChat, getAttachmentUrl, isAvailable as unipileAvailable } from '../services/unipile.js';
import { applyScriptVariables } from '../services/chatbot-engine.js';
import { onOutboundMessage } from '../services/auto-activities.js';
import supabase from '../services/supabase.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } }); // 16MB max

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
                    const startMsgId = chatResult?.message_id || `human_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                    const msg = await saveMessage({
                        conversation_id:   req.params.conversationId,
                        direction:         'outbound',
                        sender_type:       'human',
                        sender_name:       req.user?.name || 'Atendente',
                        sent_by_user_id:   req.user?.id || null,
                        sent_by_name:      req.user?.name || null,
                        content:           text,
                        attachments:       [],
                        unipile_message_id: startMsgId,
                    });
                    await updateConversation(req.params.conversationId, {
                        chatbot_stage: 'human', status: 'in_progress',
                        last_message_at: new Date().toISOString(),
                        assigned_user_id: req.user?.id || null,
                    });
                    // Auto-create WhatsApp activity in Pipedrive (fire and forget)
                    onOutboundMessage(req.params.conversationId, req.user?.id).catch(() => {});
                    return res.json({ success: true, message: msg, chat_started: true });
                }
            }
            if (!chatId) return res.status(400).json({ error: 'Sem chatId e sem telefone para iniciar conversa' });
        }

        // Envia via Unipile e captura ID real para deduplicação
        const sendResult = await sendMessage(chatId, text);
        const realMsgId = sendResult?.message_id || sendResult?.id || `human_${Date.now()}_${Math.random().toString(36).slice(2)}`;

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
            unipile_message_id: realMsgId,
        });

        // Garante que a conversa está em modo humano + auto-atribui ao usuário
        await updateConversation(req.params.conversationId, {
            chatbot_stage: 'human',
            status: 'in_progress',
            last_message_at: new Date().toISOString(),
            assigned_user_id: req.user?.id || null,
        });

        // Auto-create WhatsApp activity in Pipedrive (fire and forget)
        onOutboundMessage(req.params.conversationId, req.user?.id).catch(() => {});

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
            assigned_user_id: req.user?.id || null,
        });

        // Auto-create WhatsApp activity in Pipedrive (fire and forget)
        onOutboundMessage(req.params.conversationId, req.user?.id).catch(() => {});

        res.json({ success: true, message: msg, applied_text: text });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/messages/:conversationId/send-media — Envia mensagem com mídia
router.post('/messages/:conversationId/send-media', upload.single('file'), async (req, res) => {
    try {
        const text = req.body.text || '';
        let chatId = req.body.chatId || null;
        const file = req.file;

        if (!file && !text) return res.status(400).json({ error: 'Texto ou arquivo é obrigatório' });
        if (!chatId) {
            // Resolve chatId da conversa
            const { data: conv } = await supabase
                .from('conversations')
                .select('whatsapp_chat_id')
                .eq('id', req.params.conversationId)
                .single();
            chatId = conv?.whatsapp_chat_id;
        }
        if (!chatId) return res.status(400).json({ error: 'Conversa sem chat WhatsApp vinculado' });

        // Envia via Unipile com attachment e captura ID real
        const mediaResult = await sendMessage(chatId, text || null, file?.buffer, file?.originalname);
        const mediaMsgId = mediaResult?.message_id || mediaResult?.id || `media_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        // Monta metadados do attachment para salvar no banco
        const attachments = file ? [{
            name: file.originalname,
            mime_type: file.mimetype,
            size: file.size,
        }] : [];

        const msg = await saveMessage({
            conversation_id:    req.params.conversationId,
            direction:          'outbound',
            sender_type:        'human',
            sender_name:        req.user?.name || 'Atendente',
            sent_by_user_id:    req.user?.id || null,
            sent_by_name:       req.user?.name || null,
            content:            text || (file ? `📎 ${file.originalname}` : ''),
            attachments,
            unipile_message_id: mediaMsgId,
        });

        await updateConversation(req.params.conversationId, {
            chatbot_stage: 'human',
            status: 'in_progress',
            last_message_at: new Date().toISOString(),
            assigned_user_id: req.user?.id || null,
        });

        onOutboundMessage(req.params.conversationId, req.user?.id).catch(() => {});

        res.json({ success: true, message: msg });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/messages/:conversationId/note — Salva anotação interna ────
router.post('/messages/:conversationId/note', async (req, res) => {
    try {
        const { text } = req.body;
        if (!text?.trim()) return res.status(400).json({ error: 'text é obrigatório' });

        const msg = await saveMessage({
            conversation_id:    req.params.conversationId,
            direction:          'outbound',
            sender_type:        'note',
            sender_name:        req.user?.name || 'Nota',
            sent_by_user_id:    req.user?.id || null,
            sent_by_name:       req.user?.name || null,
            content:            text.trim(),
            attachments:        [],
            unipile_message_id: `note_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        });

        res.json({ success: true, message: msg });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/attachments/:messageId/:index — Proxy para mídia do Unipile
router.get('/attachments/:messageId/:index', async (req, res) => {
    try {
        if (!unipileAvailable()) return res.status(503).json({ error: 'Unipile não configurado' });

        const attPath = `${req.params.messageId}/${req.params.index}`;
        if (!attPath) return res.status(400).json({ error: 'Attachment path obrigatório' });

        const url = getAttachmentUrl(`att://_/${attPath}`);
        if (!url) return res.status(404).json({ error: 'URL não encontrada' });

        const upstream = await fetch(url);
        if (!upstream.ok) return res.status(upstream.status).json({ error: 'Falha ao buscar attachment' });

        // Repassa content-type e corpo
        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'private, max-age=86400'); // cache 24h

        const buffer = await upstream.arrayBuffer();
        res.send(Buffer.from(buffer));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
