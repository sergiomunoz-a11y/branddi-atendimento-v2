/**
 * Pipedrive Service — Wrappers da API do Pipedrive
 * Versão simplificada focada em atendimento (Person + Org + Deal + Activity)
 */
import 'dotenv/config';
import logger from './logger.js';

const BASE  = `https://${process.env.PIPEDRIVE_DOMAIN}/api/v1`;
const TOKEN = process.env.PIPEDRIVE_API_TOKEN;

// ─── Core Wrappers ────────────────────────────────────────────────────

export async function pdGet(endpoint) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${endpoint}${sep}api_token=${TOKEN}`);
    return res.json();
}

export async function pdPost(endpoint, data) {
    const res = await fetch(`${BASE}${endpoint}?api_token=${TOKEN}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    return res.json();
}

export async function pdPut(endpoint, data) {
    const res = await fetch(`${BASE}${endpoint}?api_token=${TOKEN}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    return res.json();
}

// ─── Person ───────────────────────────────────────────────────────────

export async function createPerson({ name, phone, email, company_name }) {
    const payload = { name };
    if (phone) payload.phone = [{ value: phone, label: 'mobile', primary: true }];
    if (email) payload.email = [{ value: email, label: 'work', primary: true }];

    if (company_name) {
        const orgId = await findOrCreateOrg(company_name);
        if (orgId) payload.org_id = orgId;
    }

    const res = await pdPost('/persons', payload);
    return res.data || null;
}

export async function findPersonByPhone(phone) {
    const term = phone.replace(/\D/g, '').slice(-9);
    const res = await pdGet(`/persons/search?term=${term}&fields=phone&limit=1`);
    return res.data?.items?.[0]?.item || null;
}

// ─── Organization ─────────────────────────────────────────────────────

export async function findOrCreateOrg(name) {
    if (!name) return null;

    const search = await pdGet(`/organizations/search?term=${encodeURIComponent(name)}&limit=1`);
    const found  = search.data?.items?.[0]?.item;
    if (found) return found.id;

    const created = await pdPost('/organizations', { name });
    return created.data?.id || null;
}

// ─── Deal ─────────────────────────────────────────────────────────────

const LABEL_INBOUND = '66';

export async function createDeal({ title, personId, orgId, pipelineId, stageId, ownerId, label }) {
    const labelIds = label ? `${LABEL_INBOUND},${label}` : LABEL_INBOUND;

    const payload = {
        title,
        person_id:   personId   || undefined,
        org_id:      orgId      || undefined,
        pipeline_id: pipelineId || undefined,
        stage_id:    stageId    || undefined,
        user_id:     ownerId    || undefined,
        label:       labelIds,
    };
    const res = await pdPost('/deals', payload);
    return res.data || null;
}

// ─── Activity (nota de conversa) ──────────────────────────────────────

export async function createWhatsAppActivity({ dealId, personId, subject, transcript, done = true }) {
    const payload = {
        subject,
        type:      'whatsapp',
        done:      done ? 1 : 0,
        due_date:  new Date().toISOString().split('T')[0],
        due_time:  new Date().toTimeString().split(' ')[0].substring(0, 5),
        note:      `<b>WhatsApp — ${subject}</b><br><br><pre>${transcript}</pre>`,
    };
    if (dealId)   payload.deal_id   = parseInt(dealId);
    if (personId) payload.person_id = parseInt(personId);

    const res = await pdPost('/activities', payload);
    return res.data || null;
}

// ─── Deals for Person ────────────────────────────────────────────────

export async function getDealsForPerson(personId) {
    const res = await pdGet(`/persons/${personId}/deals?status=all_not_deleted&limit=100`);
    return res.data || [];
}

export async function findPersonWithDeals(phone) {
    const term = phone.replace(/\D/g, '').slice(-9);
    const res = await pdGet(`/persons/search?term=${term}&fields=phone&limit=5`);
    const items = res.data?.items || [];

    const results = [];
    for (const item of items) {
        const person = item.item;
        const deals = await getDealsForPerson(person.id);
        results.push({ person, deals });
    }
    return results;
}

// ─── Pipelines ────────────────────────────────────────────────────────

export async function getPipelines() {
    const res = await pdGet('/pipelines');
    return res.data || [];
}

export async function getStages(pipelineId) {
    const res = await pdGet(`/stages?pipeline_id=${pipelineId}`);
    return res.data || [];
}
