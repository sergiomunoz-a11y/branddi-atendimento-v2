/**
 * Leads Routes — CRUD de leads, sync com CRM e histórico de conversas
 * v2: Adiciona validação em PUT com maxLength
 */
import { Router } from 'express';
import {
    getLeads, getLeadById, updateLead, getConversationHistory, getMessages
} from '../services/supabase.js';
import { queueLeadSync } from '../services/crm-sync.js';
import {
    createPerson, findPersonByPhone, findOrCreateOrg, createDeal,
    findPersonWithDeals, getDealsForPerson, pdGet, getPersonLabelOptions, updatePersonLabels
} from '../services/pipedrive.js';
import { validate } from '../middleware/validate.js';
import supabase from '../services/supabase.js';

const router = Router();

// Helper: resolve o token Pipedrive do user logado (individual ou fallback global)
async function getUserPipedriveToken(userId) {
    if (!userId) return process.env.PIPEDRIVE_API_TOKEN;
    try {
        const { data } = await supabase
            .from('platform_users')
            .select('pipedrive_api_token')
            .eq('id', userId)
            .single();
        return data?.pipedrive_api_token || process.env.PIPEDRIVE_API_TOKEN;
    } catch {
        return process.env.PIPEDRIVE_API_TOKEN;
    }
}

// ─── GET /api/leads — Lista leads com filtros ─────────────────────────
router.get('/leads', async (req, res) => {
    try {
        const { limit = 50, offset = 0, classification, origin, search } = req.query;
        const leads = await getLeads({
            limit: parseInt(limit), offset: parseInt(offset),
            classification, origin, search,
        });
        res.json({ leads, total: leads.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/leads/:id — Detalhes do lead ────────────────────────────
router.get('/leads/:id', async (req, res) => {
    try {
        const lead = await getLeadById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
        res.json({ lead });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PUT /api/leads/:id — Atualiza dados do lead ──────────────────────
router.put('/leads/:id', async (req, res) => {
    try {
        const allowed = ['name', 'phone', 'email', 'company_name', 'classification'];
        const updates = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) updates[key] = req.body[key];
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'Nenhum campo válido fornecido' });
        }

        // Validação de campos com maxLength
        const err = validate(updates, {
            name:           { maxLength: 200, type: 'string' },
            phone:          { maxLength: 200, type: 'string' },
            email:          { maxLength: 200, type: 'string' },
            company_name:   { maxLength: 200, type: 'string' },
            classification: { maxLength: 200, type: 'string' },
        });
        if (err) return res.status(400).json({ error: err });

        const lead = await updateLead(req.params.id, updates);
        res.json({ success: true, lead });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/leads/:id/sync-crm — Sync IMEDIATO com Pipedrive ──────
// Cria pessoa + org + deal no funil configurado nas Settings
router.post('/leads/:id/sync-crm', async (req, res) => {
    try {
        const lead = await getLeadById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

        // Se já tem deal, retorna sucesso sem recriar
        if (lead.crm_deal_id) {
            return res.json({
                success: true,
                already_synced: true,
                crm_deal_id: lead.crm_deal_id,
                message: `Lead já sincronizado (Deal #${lead.crm_deal_id})`,
            });
        }

        // 1. Cria ou encontra Person no Pipedrive
        let personId = lead.crm_person_id ? parseInt(lead.crm_person_id) : null;
        let orgId    = lead.crm_org_id    ? parseInt(lead.crm_org_id)    : null;

        if (!personId) {
            let person = null;
            if (lead.phone) person = await findPersonByPhone(lead.phone);
            if (!person) {
                person = await createPerson({
                    name:         lead.name,
                    phone:        lead.phone ? `55${lead.phone}` : null,
                    email:        lead.email,
                    company_name: lead.company_name,
                });
            }
            if (person) {
                personId = person.id;
                orgId    = person.org_id || orgId;
                await updateLead(lead.id, { crm_person_id: person.id?.toString() });
            }
        }

        // 2. Cria Org separadamente se não veio da pessoa
        if (!orgId && lead.company_name) {
            orgId = await findOrCreateOrg(lead.company_name);
            if (orgId) await updateLead(lead.id, { crm_org_id: orgId?.toString() });
        }

        // 3. Lê configurações de funil/etapa/proprietário
        let pipelineId = 5, stageId = 208, ownerId = null;
        try {
            const { getSettingValue } = await import('../routes/settings.js');
            pipelineId = parseInt(await getSettingValue('pipedrive_pipeline_id', 5));
            stageId    = parseInt(await getSettingValue('pipedrive_stage_id', 208));
            ownerId    = await getSettingValue('pipedrive_owner_id', null);
        } catch { /* usa defaults */ }

        // 4. Busca deals existentes da pessoa ANTES de criar novo
        const meta  = lead.metadata || {};
        let deal = null;
        let dealAlreadyExisted = false;

        if (personId) {
            try {
                const existingDeals = await getDealsForPerson(personId);
                if (existingDeals.length > 0) {
                    deal = existingDeals[0];
                    dealAlreadyExisted = true;
                }
            } catch { /* se falhar, cria novo */ }
        }

        if (!deal) {
            const title = `${lead.name || 'Lead'} — ${lead.company_name || 'WhatsApp'} [Inbound WA]`;
            deal = await createDeal({
                title,
                personId,
                orgId,
                pipelineId,
                stageId,
                ownerId:  ownerId ? parseInt(ownerId) : undefined,
                label:    lead.classification === 'comercial' ? 'hot' : undefined,
            });
        }

        if (!deal) return res.status(500).json({ error: 'Falha ao criar deal no Pipedrive' });

        // 5. Nota com domínio e contexto (só para deals novos)
        if (!dealAlreadyExisted && (meta.domain || meta.context)) {
            const noteLines = [];
            if (meta.domain)  noteLines.push(`🌐 <b>Site:</b> ${meta.domain}`);
            if (meta.context) noteLines.push(`💬 <b>Contexto:</b> ${meta.context}`);
            noteLines.push(`📱 <b>Origem:</b> WhatsApp Inbound`);
            noteLines.push(`📞 <b>Telefone:</b> ${lead.phone || '—'}`);
            try {
                const { pdPost } = await import('../services/pipedrive.js');
                await pdPost('/notes', {
                    content: noteLines.join('<br>'),
                    deal_id: deal.id,
                    pinned_to_deal_flag: 1,
                });
            } catch { /* nota não crítica */ }
        }

        await updateLead(lead.id, {
            crm_deal_id:    deal.id?.toString(),
            crm_person_id:  personId?.toString(),
            crm_org_id:     orgId?.toString(),
            last_synced_at: new Date().toISOString(),
        });

        res.json({
            success:     true,
            crm_deal_id: deal.id,
            message:     dealAlreadyExisted
                ? `Lead vinculado ao Deal existente #${deal.id}!`
                : `Deal #${deal.id} criado no funil Inbound SDR!`,
        });
    } catch (err) {
        console.error('[sync-crm]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/history — Histórico completo de conversas ──────────────
router.get('/history', async (req, res) => {
    try {
        const { limit = 50, offset = 0, status, classification, origin, search, days } = req.query;
        const conversations = await getConversationHistory({
            limit: parseInt(limit), offset: parseInt(offset),
            status, classification, origin, search,
            days: days ? parseInt(days) : undefined,
        });
        res.json({ conversations, total: conversations.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/history/:convId/messages ───────────────────────────────
router.get('/history/:convId/messages', async (req, res) => {
    try {
        const messages = await getMessages(req.params.convId, { limit: 100 });
        res.json({ messages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/leads/:id/deals — Todos os deals vinculados ao telefone ─
router.get('/leads/:id/deals', async (req, res) => {
    try {
        const lead = await getLeadById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
        if (!lead.phone) return res.json({ deals: [], persons: [] });

        const pipedriveDomain = process.env.PIPEDRIVE_DOMAIN || 'app.pipedrive.com';
        const results = await findPersonWithDeals(lead.phone);

        const allDeals = [];
        const persons = [];

        const labelOptions = getPersonLabelOptions();

        for (const { person, deals } of results) {
            // Resolve label names from IDs
            const personLabelIds = person.label_ids || [];
            const personLabels = personLabelIds.map(id => {
                const opt = labelOptions.find(o => o.id === id);
                return opt || { id, label: `#${id}`, color: 'gray' };
            });

            persons.push({
                id: person.id,
                name: person.name,
                phone: person.phone?.[0]?.value || lead.phone,
                email: person.email?.[0]?.value || null,
                job_title: person.job_title || null,
                org_name: person.org_name || null,
                label_ids: personLabelIds,
                labels: personLabels,
            });

            for (const d of deals) {
                // Busca nome do stage
                let stage_name = '—';
                if (d.stage_id) {
                    try {
                        const stageData = await pdGet(`/stages/${d.stage_id}`);
                        stage_name = stageData?.data?.name || '—';
                    } catch { /* ignora */ }
                }

                allDeals.push({
                    id: d.id,
                    title: d.title,
                    status: d.status,
                    stage_name,
                    pipeline_id: d.pipeline_id,
                    value: d.value,
                    currency: d.currency,
                    owner_name: d.owner_name || '—',
                    person_id: person.id,
                    person_name: person.name,
                    link: `https://${pipedriveDomain}/deal/${d.id}`,
                });
            }
        }

        res.json({ deals: allDeals, persons, label_options: labelOptions });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PUT /api/leads/:id/person-labels — Atualiza etiquetas do Person ──
router.put('/leads/:id/person-labels', async (req, res) => {
    try {
        const { person_id, label_ids } = req.body;
        if (!person_id) return res.status(400).json({ error: 'person_id obrigatório' });
        if (!Array.isArray(label_ids)) return res.status(400).json({ error: 'label_ids deve ser array' });

        const updated = await updatePersonLabels(parseInt(person_id), label_ids);
        if (!updated) return res.status(500).json({ error: 'Falha ao atualizar etiquetas' });

        const labelOptions = getPersonLabelOptions();
        const labels = (updated.label_ids || []).map(id => {
            const opt = labelOptions.find(o => o.id === id);
            return opt || { id, label: `#${id}`, color: 'gray' };
        });

        res.json({ ok: true, label_ids: updated.label_ids || [], labels });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/leads/:id/deal — Busca deal do Pipedrive ───────────────
router.get('/leads/:id/deal', async (req, res) => {
    try {
        const lead = await getLeadById(req.params.id);
        if (!lead?.crm_deal_id) return res.json({ deal: null });

        const base  = `https://${process.env.PIPEDRIVE_DOMAIN}/api/v1`;
        const token = process.env.PIPEDRIVE_API_TOKEN;

        const r = await fetch(`${base}/deals/${lead.crm_deal_id}?api_token=${token}`);
        const data = await r.json();

        // Deal não encontrado ou deletado
        if (!data?.data || data.data.status === 'deleted') return res.json({ deal: null });

        const d = data.data;

        // Busca nome do stage via endpoint de stages
        let stage_name = '—';
        if (d.stage_id) {
            try {
                const sr = await fetch(`${base}/stages/${d.stage_id}?api_token=${token}`);
                const sd = await sr.json();
                stage_name = sd?.data?.name || '—';
            } catch { /* ignora */ }
        }

        const pipedriveDomain = process.env.PIPEDRIVE_DOMAIN || 'app.pipedrive.com';
        const dealLink = `https://${pipedriveDomain}/deal/${d.id}`;

        res.json({
            deal: {
                id:         d.id,
                title:      d.title,
                stage_name,
                status:     d.status,
                value:      d.value,
                currency:   d.currency,
                owner_name: d.owner_name || d.user_id?.name || '—',
                link:       dealLink,
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/leads/:id/notes — Cria anotação (Note) no Pipedrive com transcrição
// Aceita deal_id explícito no body (deal picker) ou fallback para lead.crm_deal_id
router.post('/leads/:id/notes', async (req, res) => {
    try {
        const { conversation_id, deal_id } = req.body;
        const lead = await getLeadById(req.params.id);
        const targetDealId = deal_id || lead?.crm_deal_id;
        if (!targetDealId) return res.status(400).json({ error: 'Nenhum deal selecionado' });

        // Busca mensagens da conversa para transcrição
        const msgs = conversation_id ? await getMessages(conversation_id, { limit: 500 }) : [];
        const transcript = msgs
            .map(m => {
                const who = m.direction === 'outbound'
                    ? (m.sent_by_name || 'Equipe')
                    : (lead.name || 'Lead');
                const time = new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
                const date = new Date(m.created_at).toLocaleDateString('pt-BR');
                return `[${date} ${time}] ${who}: ${m.content || '(mídia)'}`;
            })
            .join('\n');

        const apiToken = await getUserPipedriveToken(req.user?.id);
        const dateStr = new Date().toLocaleDateString('pt-BR');

        // Cria Note no Pipedrive (não Activity)
        const base = `https://${process.env.PIPEDRIVE_DOMAIN}/api/v1`;
        const noteRes = await fetch(`${base}/notes?api_token=${apiToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `<b>📱 Transcrição WhatsApp — ${lead.name || lead.phone} — ${dateStr}</b><br><br><pre>${transcript || '(sem mensagens)'}</pre><br><small>Gerado via Branddi Atendimento</small>`,
                deal_id: parseInt(targetDealId),
                pinned_to_deal_flag: 0,
            }),
        });
        const noteData = await noteRes.json();

        res.json({ ok: true, deal_id: targetDealId, note_id: noteData?.data?.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
