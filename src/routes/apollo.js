/**
 * Apollo Routes — Enriquece contatos do Pipedrive usando Apollo.io.
 *
 * Cada chamada ao /enrich consome 1 crédito da conta Apollo. Por isso,
 * a feature é gated por um platform_setting (`apollo_enabled`) que só
 * o Admin pode alterar (via /api/settings).
 */
import { Router } from 'express';
import { getSettingValue, updateLead, normalizePhone } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import { isApolloConfigured, enrichPerson } from '../services/apollo.js';
import { pdGet, pdPut } from '../services/pipedrive.js';
import logger from '../services/logger.js';

const router = Router();

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
    // Admin sempre pode. Para não-Admin, requer permissions.apollo_enabled.
    const isAdmin = req.user?.role === 'Admin';
    const userAllowed = !!req.user?.permissions?.apollo_enabled;
    if (!isAdmin && !userAllowed) {
        res.status(403).json({ error: 'Seu perfil não tem permissão para usar o Apollo. Fale com o administrador.' });
        return false;
    }
    return true;
}

// ─── POST /api/apollo/enrich-person ──────────────────────────────────
// Body: { person_id?, name?, email?, phone?, org_name?, domain?, linkedin_url? }
// Usa person_id do Pipedrive (se fornecido) pra hidratar inputs antes de chamar o Apollo.
router.post('/apollo/enrich-person', async (req, res) => {
    if (!(await ensureEnabled(req, res))) return;

    try {
        let { person_id, name, email, phone, org_name, domain, linkedin_url } = req.body || {};

        // Se recebeu person_id, puxa dados atuais do Pipedrive pra melhorar o match
        if (person_id && (!name || !email || !phone)) {
            try {
                const pd = await pdGet(`/persons/${person_id}`);
                const p = pd?.data;
                if (p) {
                    name    = name    || p.name || null;
                    email   = email   || p.email?.[0]?.value || null;
                    phone   = phone   || p.phone?.[0]?.value || null;
                    org_name = org_name || p.org_name || null;
                }
            } catch (e) {
                logger.warn('Apollo: pdGet person failed', { person_id, error: e.message });
            }
        }

        const person = await enrichPerson({
            name, email,
            phone_number: phone,
            organization_name: org_name,
            domain,
            linkedin_url,
        });

        if (!person) {
            return res.json({ matched: false, person: null });
        }

        logger.info('Apollo enrich success', {
            person_id: person_id || null,
            user_id: req.user?.id,
            has_email: !!person.email,
            has_title: !!person.title,
        });

        res.json({ matched: true, person });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// ─── POST /api/apollo/enrich-and-save/:person_id ─────────────────────
// Enriquece E salva os campos descobertos no person do Pipedrive.
// Apenas campos VAZIOS no Pipedrive são preenchidos — nunca sobrescreve.
router.post('/apollo/enrich-and-save/:person_id', async (req, res) => {
    if (!(await ensureEnabled(req, res))) return;

    const personId = req.params.person_id;
    try {
        const pd = await pdGet(`/persons/${personId}`);
        const current = pd?.data;
        if (!current) return res.status(404).json({ error: 'Pessoa não encontrada no Pipedrive' });

        const person = await enrichPerson({
            name: current.name,
            email: current.email?.[0]?.value,
            phone_number: current.phone?.[0]?.value,
            organization_name: current.org_name,
        });

        if (!person) return res.json({ matched: false, updated: {} });

        // Monta update só pra campos vazios — nunca sobrescreve curadoria manual
        const updates = {};
        if (!current.job_title && person.title) updates.job_title = person.title;

        // Email: só adiciona se Pipedrive está sem email útil
        const hasEmail = (current.email || []).some(e => e.value && e.value.trim());
        if (!hasEmail && person.email) {
            updates.email = [{ value: person.email, primary: true, label: 'work' }];
        }

        // Telefone: só adiciona se Pipedrive não tem nenhum número válido (>5 dígitos)
        const hasPhone = (current.phone || []).some(p => p.value && String(p.value).length > 5);
        if (!hasPhone && Array.isArray(person.phone_numbers) && person.phone_numbers.length > 0) {
            updates.phone = person.phone_numbers.slice(0, 3).map((num, i) => ({
                value: num,
                primary: i === 0,
                label: 'work',
            }));
        }

        // LinkedIn: Pipedrive guarda em campos customizados → deixa fora por default
        // (o cliente pode adicionar um campo custom e mapear no futuro)

        if (Object.keys(updates).length === 0) {
            return res.json({ matched: true, updated: {}, supabase_updated: null, person, note: 'Apollo encontrou dados, mas nenhum campo vazio para preencher.' });
        }

        await pdPut(`/persons/${personId}`, updates);
        logger.info('Apollo enrich-and-save updated Pipedrive person', { personId, fields: Object.keys(updates) });

        // Também atualiza lead no Supabase se existir (campos vazios apenas)
        let supabaseUpdated = null;
        try {
            const { data: lead } = await supabase
                .from('leads')
                .select('id, name, phone, company_name')
                .eq('crm_person_id', String(personId))
                .limit(1)
                .maybeSingle();

            if (lead) {
                const leadUpdates = {};
                if ((!lead.phone || lead.phone.length < 6) && updates.phone?.[0]?.value) {
                    leadUpdates.phone = normalizePhone(updates.phone[0].value);
                }
                if (!lead.company_name && current.org_name) {
                    leadUpdates.company_name = current.org_name;
                }
                if (!lead.name && person.name) {
                    leadUpdates.name = person.name;
                }
                if (Object.keys(leadUpdates).length > 0) {
                    await updateLead(lead.id, leadUpdates);
                    supabaseUpdated = { lead_id: lead.id, fields: Object.keys(leadUpdates) };
                    logger.info('Apollo enrich-and-save updated Supabase lead', supabaseUpdated);
                }
            }
        } catch (err) {
            // Sync opcional — não quebra o fluxo se falhar
            logger.warn('Apollo: supabase lead sync failed', { error: err.message, personId });
        }

        res.json({ matched: true, updated: updates, supabase_updated: supabaseUpdated, person });
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

export default router;
