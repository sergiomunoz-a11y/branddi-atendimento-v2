/**
 * Pipedrive Service — Wrappers da API do Pipedrive
 * Versão simplificada focada em atendimento (Person + Org + Deal + Activity)
 */
import 'dotenv/config';
import logger from './logger.js';

const BASE  = `https://${process.env.PIPEDRIVE_DOMAIN}/api/v1`;
const TOKEN = process.env.PIPEDRIVE_API_TOKEN;

// ─── Core Wrappers ────────────────────────────────────────────────────

// tokenOverride: permite usar token individual do user em vez do global
export async function pdGet(endpoint, tokenOverride) {
    const token = tokenOverride || TOKEN;
    const sep = endpoint.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${endpoint}${sep}api_token=${token}`);
    return res.json();
}

export async function pdPost(endpoint, data, tokenOverride) {
    const token = tokenOverride || TOKEN;
    const res = await fetch(`${BASE}${endpoint}?api_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    return res.json();
}

export async function pdPut(endpoint, data, tokenOverride) {
    const token = tokenOverride || TOKEN;
    const res = await fetch(`${BASE}${endpoint}?api_token=${token}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    return res.json();
}

// ─── Phone normalization (BR) ────────────────────────────────────────

function normalizePhoneTerms(phone) {
    const digits = phone.replace(/\D/g, '');

    // Remove country code 55 se presente
    const local = digits.startsWith('55') && digits.length >= 12
        ? digits.slice(2)
        : digits;

    // Gera termos de busca do mais específico ao menos
    const terms = [];

    // 1. Número local completo (DDD + celular = 10-11 dígitos)
    if (local.length >= 10) terms.push(local);

    // 2. Se celular sem 9° dígito (10 digs), tenta com 9 inserido
    //    Se celular com 9° dígito (11 digs), tenta sem ele
    if (local.length === 10) {
        const ddd = local.slice(0, 2);
        const num = local.slice(2);
        terms.push(`${ddd}9${num}`); // adiciona 9° dígito
    } else if (local.length === 11 && local[2] === '9') {
        terms.push(local.slice(0, 2) + local.slice(3)); // remove 9° dígito
    }

    // 3. Últimos 8 dígitos (subscriber number sem DDD/prefixo)
    if (digits.length >= 8) terms.push(digits.slice(-8));

    return [...new Set(terms)]; // deduplica
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
    const terms = normalizePhoneTerms(phone);

    for (const term of terms) {
        const res = await pdGet(`/persons/search?term=${term}&fields=phone&limit=5`);
        const items = res.data?.items || [];
        if (items.length > 0) return items[0].item;
    }
    return null;
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
    const terms = normalizePhoneTerms(phone);
    const seenPersonIds = new Set();
    const results = [];

    // Busca com TODOS os termos para cobrir variações de formato (com/sem 9°dígito)
    for (const term of terms) {
        const res = await pdGet(`/persons/search?term=${term}&fields=phone&limit=5`);
        const items = res.data?.items || [];

        for (const item of items) {
            const person = item.item;
            if (seenPersonIds.has(person.id)) continue;
            seenPersonIds.add(person.id);

            // Busca dados completos do person (inclui label_ids)
            const fullPerson = await getPersonFull(person.id);
            const deals = await getDealsForPerson(person.id);
            results.push({ person: fullPerson || person, deals });
        }
    }
    return results;
}

// ─── Person Labels ──────────────────────────────────────────────────

// Etiquetas disponíveis no Pipedrive (cache estático)
const PERSON_LABEL_OPTIONS = [
    { id: 418, label: 'Brand Bidding', color: 'blue' },
    { id: 419, label: 'Fraude', color: 'red' },
    { id: 420, label: 'Violação de Marca', color: 'yellow' },
    { id: 421, label: 'BUY BOX PROTECTION', color: 'purple' },
    { id: 542, label: 'BLACKLIST', color: 'dark-gray' },
    { id: 543, label: 'NÃO CONTATAR WHATSAPP', color: 'green' },
];

export function getPersonLabelOptions() {
    return PERSON_LABEL_OPTIONS;
}

export async function getPersonFull(personId) {
    const res = await pdGet(`/persons/${personId}`);
    return res.data || null;
}

export async function updatePersonLabels(personId, labelIds) {
    const res = await pdPut(`/persons/${personId}`, { label_ids: labelIds });
    return res.data || null;
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
