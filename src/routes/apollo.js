/**
 * Apollo Routes — Enriquece contatos do Pipedrive usando Apollo.io.
 *
 * Phone reveal é ASYNC: Apollo devolve o número via webhook ~5-30s depois.
 *
 * Fluxo:
 *   1. POST /api/apollo/enrich-and-save/:personId
 *      - busca dados atuais do person no Pipedrive
 *      - grava row pending em apollo_enrichments (ref = uuid)
 *      - chama Apollo /people/match com reveal_phone_number + webhook_url=<base>/api/webhooks/apollo?ref=<uuid>
 *      - salva IMEDIATAMENTE no Pipedrive os campos síncronos (title/email)
 *      - responde { ref, sync_updated }
 *   2. POST /api/webhooks/apollo?ref=<uuid>  (público, sem auth)
 *      - Apollo dispara com o número revelado
 *      - grava phone no Pipedrive + Supabase se vazio
 *      - marca row como completed
 *   3. GET /api/apollo/enrichment/:ref
 *      - front faz polling aqui até ver completed/not_found/error
 */
import { Router } from 'express';
import { getSettingValue, updateLead, normalizePhone } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import { isApolloConfigured, matchPerson } from '../services/apollo.js';
import { pdGet, pdPut } from '../services/pipedrive.js';
import logger from '../services/logger.js';

const router = Router();

function getPublicBaseUrl() {
    return process.env.PUBLIC_URL
        || process.env.FRONTEND_URL
        || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
}

async function ensureEnabled(req, res) {
    if (!isApolloConfigured()) {
        res.status(503).json({ error: 'Apollo não configurado neste ambiente.' });
        return false;
    }
    const globalEnabled = await getSettingValue('apollo_enabled', false);
    if (!globalEnabled) {
        res.status(403).json({ error: 'Enriquecimento Apollo está desabilitado globalmente. Admin pode habilitar em Configurações.' });
        return false;
    }
    const isAdmin = req.user?.role === 'Admin';
    const userAllowed = !!req.user?.permissions?.apollo_enabled;
    if (!isAdmin && !userAllowed) {
        res.status(403).json({ error: 'Seu perfil não tem permissão para usar o Apollo. Fale com o administrador.' });
        return false;
    }
    return true;
}

// ─── POST /api/apollo/enrich-and-save/:person_id ─────────────────────
// Dispara match+reveal no Apollo. Retorna { ref, sync_updated } imediato.
// O número chega via webhook depois.
router.post('/apollo/enrich-and-save/:person_id', async (req, res) => {
    if (!(await ensureEnabled(req, res))) return;

    const personId = req.params.person_id;
    try {
        const pd = await pdGet(`/persons/${personId}`);
        const current = pd?.data;
        if (!current) return res.status(404).json({ error: 'Pessoa não encontrada no Pipedrive' });

        const baseUrl = getPublicBaseUrl();
        if (!baseUrl) {
            return res.status(500).json({ error: 'Servidor sem URL pública configurada. Defina PUBLIC_URL no ambiente.' });
        }

        // 1. Cria row pending para receber webhook depois
        const { data: row, error: insErr } = await supabase
            .from('apollo_enrichments')
            .insert({
                pipedrive_person_id: String(personId),
                user_id: req.user?.id || null,
                status: 'pending',
                person_name: current.name || null,
            })
            .select('ref')
            .single();
        if (insErr || !row?.ref) {
            logger.error('Failed to create enrichment row', { error: insErr?.message });
            return res.status(500).json({ error: 'Falha ao registrar enriquecimento.' });
        }
        const ref = row.ref;
        const webhookUrl = `${baseUrl}/api/webhooks/apollo?ref=${ref}`;

        // 2. Dispara match no Apollo — reveal_phone_number só se o Pipedrive NÃO tem número
        const hasPhone = (current.phone || []).some(p => p.value && String(p.value).length > 5);
        const wantsPhone = !hasPhone;

        let apolloResp;
        try {
            apolloResp = await matchPerson({
                name: current.name,
                email: current.email?.[0]?.value,
                phone_number: current.phone?.[0]?.value,
                organization_name: current.org_name,
                reveal_phone_number: wantsPhone,
                webhook_url: wantsPhone ? webhookUrl : null,
            });
        } catch (err) {
            await supabase.from('apollo_enrichments')
                .update({ status: 'error', error: err.message, completed_at: new Date().toISOString() })
                .eq('ref', ref);
            return res.status(502).json({ error: err.message, ref });
        }

        // 3. Sem match: marca not_found e retorna
        if (!apolloResp.matched) {
            await supabase.from('apollo_enrichments')
                .update({ status: 'not_found', completed_at: new Date().toISOString() })
                .eq('ref', ref);
            return res.json({ ref, matched: false, sync_updated: {}, phone_pending: false });
        }

        const person = apolloResp.person;

        // 4. Grava síncronos no Pipedrive (title, email) — só campos vazios
        const updates = {};
        if (!current.job_title && person.title) updates.job_title = person.title;
        const hasEmail = (current.email || []).some(e => e.value && e.value.trim());
        if (!hasEmail && person.email) {
            updates.email = [{ value: person.email, primary: true, label: 'work' }];
        }
        if (Object.keys(updates).length > 0) {
            try {
                await pdPut(`/persons/${personId}`, updates);
            } catch (err) {
                logger.warn('Apollo sync PD update failed', { personId, error: err.message });
            }
        }

        // 5. Sync Supabase lead (name/company) com o que veio síncrono
        await syncLeadFromApollo(personId, current, person, { includePhone: false });

        // 6. Guarda apollo_request_id pra correlacionar webhook (se tem reveal pendente)
        const apolloReqId = apolloResp.phone_enrichment?.request_id || null;
        const phoneStatus = apolloResp.phone_enrichment?.status || null;
        const finalStatus = wantsPhone && phoneStatus === 'pending'
            ? 'pending'   // espera webhook
            : 'completed'; // nada mais a esperar (já tinha phone OU não pediu reveal)

        await supabase.from('apollo_enrichments')
            .update({
                status: finalStatus,
                apollo_request_id: apolloReqId,
                result: { person, pipedrive_updated: updates },
                completed_at: finalStatus === 'completed' ? new Date().toISOString() : null,
            })
            .eq('ref', ref);

        logger.info('Apollo enrich dispatched', {
            ref, personId, wantsPhone, phoneStatus,
            sync_fields: Object.keys(updates),
        });

        res.json({
            ref,
            matched: true,
            sync_updated: updates,
            phone_pending: wantsPhone && phoneStatus === 'pending',
            person: { title: person.title, email: person.email, name: person.name },
        });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// ─── GET /api/apollo/enrichment/:ref — consulta status (polling) ─────
router.get('/apollo/enrichment/:ref', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('apollo_enrichments')
            .select('ref, status, phone, error, completed_at, pipedrive_person_id, person_name')
            .eq('ref', req.params.ref)
            .maybeSingle();
        if (error) return res.status(500).json({ error: error.message });
        if (!data) return res.status(404).json({ error: 'Enrichment não encontrado' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Helper: sync Supabase lead a partir do Apollo ────────────────────
async function syncLeadFromApollo(personId, current, person, { includePhone = false, phone = null } = {}) {
    try {
        const { data: lead } = await supabase
            .from('leads')
            .select('id, name, phone, company_name')
            .eq('crm_person_id', String(personId))
            .limit(1)
            .maybeSingle();
        if (!lead) return null;

        const leadUpdates = {};
        if (!lead.name && person?.name) leadUpdates.name = person.name;
        if (!lead.company_name && (current?.org_name || person?.organization?.name)) {
            leadUpdates.company_name = current?.org_name || person?.organization?.name;
        }
        if (includePhone && phone && (!lead.phone || lead.phone.length < 6)) {
            leadUpdates.phone = normalizePhone(phone);
        }
        if (Object.keys(leadUpdates).length > 0) {
            await updateLead(lead.id, leadUpdates);
            logger.info('Apollo synced Supabase lead', { lead_id: lead.id, fields: Object.keys(leadUpdates) });
            return { lead_id: lead.id, fields: Object.keys(leadUpdates) };
        }
        return null;
    } catch (err) {
        logger.warn('Apollo syncLeadFromApollo failed', { personId, error: err.message });
        return null;
    }
}

export { syncLeadFromApollo };
export default router;
