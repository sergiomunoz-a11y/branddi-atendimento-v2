/**
 * Inbox Routes — Conversas ativas e triagem
 */
import { Router } from 'express';
import {
    getInbox, updateConversation, createRoutingEvent, getDashboardStats
} from '../services/supabase.js';
import { queueConversationSync, syncConversationToPipedrive } from '../services/crm-sync.js';
import { requireRole } from '../middleware/auth.js';
import supabase from '../services/supabase.js';

const router = Router();

// ─── GET /api/inbox — Lista conversas filtradas por role/usuário ──────
router.get('/inbox', async (req, res) => {
    try {
        const { status, type, limit = 50, filter_user_id, archived } = req.query;
        const user   = req.user || {};
        const role   = user.role;
        const userId = user.id;
        const permissions = user.permissions || {};

        // archived=true só permitido para Admin
        const showArchived = archived === 'true' && role === 'Admin';

        const conversations = await getInbox({
            status,
            type,
            limit:   parseInt(limit),
            role,
            user_id: userId,
            allowed_types: role === 'Admin' ? null : (permissions.conversation_types || []),
            filter_user_id: role === 'Admin' ? (filter_user_id || null) : null,
            archived: showArchived,
        });
        res.json({ conversations, total: conversations.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/inbox/stats — Contadores do inbox ───────────────────────
router.get('/inbox/stats', async (req, res) => {
    try {
        const stats = await getDashboardStats({ days: 1 });
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/inbox/route — Roteia conversa para uma área ───────────
router.post('/inbox/route', async (req, res) => {
    try {
        const { conversation_id, to_team, reason } = req.body;
        if (!conversation_id || !to_team) {
            return res.status(400).json({ error: 'conversation_id e to_team são obrigatórios' });
        }

        const validTeams = ['comercial', 'opec', 'prospecting', 'closed'];
        if (!validTeams.includes(to_team)) {
            return res.status(400).json({ error: `to_team deve ser: ${validTeams.join(', ')}` });
        }

        const newStatus = to_team === 'closed' ? 'closed' : 'routed';

        // Cria evento de roteamento
        await createRoutingEvent({
            conversation_id,
            from_team: null,
            to_team,
            reason:    reason || `Roteado manualmente para ${to_team}`,
            routed_by: 'human',
        });

        // Atualiza conversa
        const updated = await updateConversation(conversation_id, {
            assigned_to: to_team === 'closed' ? null : to_team,
            status:      newStatus,
        });

        res.json({ success: true, conversation: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/inbox/:id/assign — Atribui conversa a time ────────────
router.post('/inbox/:id/assign', async (req, res) => {
    try {
        const { to_team, reason } = req.body;
        const conversationId = req.params.id;

        await createRoutingEvent({
            conversation_id: conversationId,
            to_team,
            reason: reason || `Atribuído a ${to_team}`,
            routed_by: 'human',
        });

        const updated = await updateConversation(conversationId, {
            assigned_to: to_team,
            status: 'in_progress',
        });

        res.json({ success: true, conversation: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/inbox/:id/close — Encerra conversa ────────────────────
router.post('/inbox/:id/close', async (req, res) => {
    try {
        const { reason } = req.body;
        const conversationId = req.params.id;

        await createRoutingEvent({
            conversation_id: conversationId,
            to_team: 'closed',
            reason:  reason || 'Conversa encerrada',
            routed_by: 'human',
        });

        const updated = await updateConversation(conversationId, {
            status: 'closed',
            assigned_to: null,
        });

        // Enfileira sync da conversa para o Pipedrive
        await queueConversationSync(conversationId, { reason });

        res.json({ success: true, conversation: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PATCH /api/inbox/:id/type — Muda tipo da conversa ───────────────
router.patch('/inbox/:id/type', async (req, res) => {
    try {
        const { type } = req.body;
        if (!['inbound', 'prospecting'].includes(type)) {
            return res.status(400).json({ error: 'type deve ser inbound ou prospecting' });
        }
        const updated = await updateConversation(req.params.id, { type });
        res.json({ success: true, conversation: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PATCH /api/inbox/:id/assign-user — Atribui a um platform_user ───
router.patch('/inbox/:id/assign-user', async (req, res) => {
    try {
        const { user_id } = req.body;
        const updated = await updateConversation(req.params.id, {
            assigned_to: user_id || null,
            status: user_id ? 'in_progress' : 'waiting',
        });
        res.json({ success: true, conversation: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/inbox/:id/archive — Arquiva conversa (Admin, reversível) ─
router.post('/inbox/:id/archive', requireRole('Admin'), async (req, res) => {
    try {
        const { error } = await supabase
            .from('conversations')
            .update({ archived_at: new Date().toISOString() })
            .eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/inbox/:id/unarchive — Restaura conversa arquivada (Admin) ─
router.post('/inbox/:id/unarchive', requireRole('Admin'), async (req, res) => {
    try {
        const { error } = await supabase
            .from('conversations')
            .update({ archived_at: null })
            .eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /api/inbox/:id — Hard delete (Admin, irreversível) ──────────
// Cascade: messages + routing_events são deletadas automaticamente (FK ON DELETE CASCADE).
// Lead permanece (FK ON DELETE SET NULL).
router.delete('/inbox/:id', requireRole('Admin'), async (req, res) => {
    try {
        const { error } = await supabase
            .from('conversations')
            .delete()
            .eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/inbox/:id/push-to-pipedrive — Envia conversa ao Pipedrive
// Cria Person + Org + Deal + Note (qualificação) + Activity (transcript).
// Qualquer atendente pode disparar. Bloqueado para leads classificados como OPEC.
router.post('/inbox/:id/push-to-pipedrive', async (req, res) => {
    try {
        const { getConversationById } = await import('../services/supabase.js');
        const conv = await getConversationById(req.params.id);
        if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

        const cls = conv.leads?.classification;
        if (cls === 'opec') {
            return res.status(400).json({
                error: 'Leads OPEC não são enviados ao Pipedrive.'
            });
        }

        const result = await syncConversationToPipedrive(req.params.id);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
