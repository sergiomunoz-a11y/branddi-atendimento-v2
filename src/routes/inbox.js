/**
 * Inbox Routes — Conversas ativas e triagem
 */
import { Router } from 'express';
import {
    getInbox, updateConversation, createRoutingEvent, getDashboardStats
} from '../services/supabase.js';
import { queueConversationSync, syncConversationToPipedrive } from '../services/crm-sync.js';
import { requireRole } from '../middleware/auth.js';
import { createWhatsAppActivity } from '../services/pipedrive.js';
import { getLeadById, logCommercialEvent } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import logger from '../services/logger.js';

const router = Router();

// ─── GET /api/inbox — Lista conversas filtradas por role/usuário ──────
router.get('/inbox', async (req, res) => {
    try {
        const { status, type, limit = 50, filter_user_id, filter_account_id, archived } = req.query;
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
            allowed_accounts: role === 'Admin' ? null : (permissions.whatsapp_accounts || []),
            filter_user_id: role === 'Admin' ? (filter_user_id || null) : null,
            filter_account_id: filter_account_id || null,
            archived: showArchived,
        });
        res.json({ conversations, total: conversations.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/inbox/conversation/:id — Busca 1 conversa por ID, sem filtros ─
// Útil quando o front precisa abrir uma conversa que não veio na listagem
// filtrada (ex: criada agora, ou fora da aba ativa). Respeita permissões:
// não-Admin só pega conversas dos seus números.
router.get('/inbox/conversation/:id', async (req, res) => {
    try {
        const { data: conv, error } = await supabase
            .from('conversations')
            .select(`
                *,
                leads(id, name, phone, company_name, classification, origin),
                messages(id, content, direction, sender_type, sender_name, sent_by_name, created_at, read_at)
            `)
            .eq('id', req.params.id)
            .order('created_at', { referencedTable: 'messages', ascending: false })
            .maybeSingle();

        if (error) return res.status(500).json({ error: error.message });
        if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });

        // Permissão: não-Admin só vê os próprios números (a não ser que esteja
        // assigned ou seja conversa nova sem account_id ainda — caso outbound).
        if (req.user?.role !== 'Admin') {
            const allowed = req.user?.permissions?.whatsapp_accounts || [];
            const allowsNullAccount = !conv.whatsapp_account_id; // conversa nova
            if (!allowsNullAccount && !allowed.includes(conv.whatsapp_account_id)) {
                return res.status(403).json({ error: 'Sem permissão para esta conversa' });
            }
        }

        const msgs = conv.messages || [];

        // Hidrata etiquetas de dono(s) — mesma cascata do getInbox:
        // display_label > connected_by_user_id > permitted users que interagiram
        let ownerNames = [];
        if (conv.whatsapp_account_id) {
            const [{ data: acc }, { data: users = [] }] = await Promise.all([
                supabase
                    .from('whatsapp_accounts')
                    .select('display_label, platform_users:connected_by_user_id(name)')
                    .eq('unipile_account_id', conv.whatsapp_account_id)
                    .maybeSingle(),
                supabase
                    .from('platform_users')
                    .select('id, name, permissions')
                    .eq('active', true),
            ]);
            if (acc?.display_label) {
                ownerNames = [acc.display_label];
            } else if (acc?.platform_users?.name) {
                ownerNames = [acc.platform_users.name.split(/\s+/)[0]];
            } else {
                const permitted = users
                    .filter(u => (u.permissions?.whatsapp_accounts || []).includes(conv.whatsapp_account_id))
                    .map(u => ({ id: u.id, first_name: (u.name || '').split(/\s+/)[0] || u.name }));
                if (permitted.length === 1) {
                    ownerNames = [permitted[0].first_name];
                } else if (permitted.length > 1) {
                    const interactedIds = new Set();
                    msgs.forEach(m => {
                        if (m.direction === 'outbound' && m.sender_type === 'human' && m.sent_by_user_id) {
                            interactedIds.add(m.sent_by_user_id);
                        }
                    });
                    ownerNames = permitted
                        .filter(u => interactedIds.has(u.id))
                        .map(u => u.first_name);
                }
            }
        }

        res.json({
            conversation: {
                ...conv,
                last_message: msgs[0] || null,
                unread_count: msgs.filter(m => m.direction === 'inbound' && !m.read_at).length,
                account_owner_name: ownerNames[0] || null,
                account_owner_names: ownerNames,
                messages: undefined,
            },
        });
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

// ─── POST /api/inbox/:id/wa-activity — Atividade WhatsApp manual (BB/FR/VM) ─
// Cria atividade CONCLUÍDA no Pipedrive com subject tagueado pelo serviço.
// Não faz dedup — SDR decide (1 deal pode ter múltiplas atividades se tiver
// múltiplos serviços contratados).
const VALID_WA_TAGS = ['BB', 'FR', 'VM'];
const WA_TAG_LABELS = {
    BB: 'Brand Bidding',
    FR: 'Fraude',
    VM: 'Violação de Marca',
};

router.post('/inbox/:id/wa-activity', async (req, res) => {
    try {
        const { tag } = req.body || {};
        if (!VALID_WA_TAGS.includes(tag)) {
            return res.status(400).json({ error: `tag inválida. Use: ${VALID_WA_TAGS.join(', ')}` });
        }

        // Busca a conversa + lead pra obter deal/person/nome
        const { data: conv, error: convErr } = await supabase
            .from('conversations')
            .select('id, lead_id')
            .eq('id', req.params.id)
            .single();
        if (convErr || !conv) return res.status(404).json({ error: 'Conversa não encontrada' });

        const lead = await getLeadById(conv.lead_id);
        if (!lead?.crm_deal_id) {
            return res.status(400).json({ error: 'Essa conversa não tem deal vinculado no Pipedrive.' });
        }

        // Token do user logado (fallback global) — pra atividade aparecer como criada por ele
        let token = process.env.PIPEDRIVE_API_TOKEN;
        if (req.user?.id) {
            try {
                const { data: pu } = await supabase
                    .from('platform_users')
                    .select('pipedrive_api_token')
                    .eq('id', req.user.id)
                    .single();
                if (pu?.pipedrive_api_token) token = pu.pipedrive_api_token;
            } catch { /* fallback global */ }
        }

        const leadName = lead.name || lead.phone || 'Lead';
        const activity = await createWhatsAppActivity({
            dealId: lead.crm_deal_id,
            personId: lead.crm_person_id || null,
            subject: `WhatsApp ${tag} — ${leadName}`,
            transcript: '',
            done: true,
            tokenOverride: token,
        });

        logger.info('Manual WhatsApp activity created', {
            conversation_id: conv.id,
            deal_id: lead.crm_deal_id,
            tag,
            user_id: req.user?.id || null,
        });

        // Loga evento pro dashboard analytics
        await logCommercialEvent(`wa_activity_${tag.toLowerCase()}`, {
            user_id: req.user?.id || null,
            conversation_id: conv.id,
            lead_id: lead.id,
            metadata: { deal_id: lead.crm_deal_id, tag },
        });

        res.json({ success: true, tag, tag_label: WA_TAG_LABELS[tag], activity_id: activity?.id || null });
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
