/**
 * Apollo.io Service — People enrichment via /people/match
 *
 * Docs: https://docs.apollo.io/reference/people-enrichment
 *
 * Usage: POST https://api.apollo.io/api/v1/people/match
 *   Header: X-Api-Key: <APOLLO_API_KEY>
 *   Body: { first_name, last_name, name, email, organization_name, domain, phone_number, reveal_personal_emails }
 *
 * Each successful match counts as 1 credit on the Apollo plan.
 */
import 'dotenv/config';
import logger from './logger.js';

const BASE = 'https://api.apollo.io/api/v1';
const API_KEY = process.env.APOLLO_API_KEY;
const TIMEOUT_MS = 12_000;

export function isApolloConfigured() {
    return !!API_KEY;
}

/**
 * Enriches a person with Apollo data.
 * Provide as many fields as available — Apollo needs at least one of:
 *   - email
 *   - name + organization_name (or domain)
 *   - linkedin_url
 *
 * Returns null if no match found. Throws on config/network errors.
 */
/**
 * Fallback search using /mixed_people/search — usado quando /people/match
 * retorna null. Cobertura maior (search é ICP-based) mas menos preciso.
 * NÃO consome crédito de enrichment, mas consome search credits separados.
 */
export async function searchPerson({ name, first_name, last_name, organization_name, domain } = {}) {
    if (!API_KEY) return null;
    const params = new URLSearchParams();
    params.set('per_page', '5');
    const fullName = name || [first_name, last_name].filter(Boolean).join(' ');
    if (fullName) params.set('q_keywords', fullName);
    if (organization_name) params.set('q_organization_name', organization_name);
    if (domain) params.set('q_organization_domains', domain);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE}/mixed_people/search?${params}`, {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        });
        if (!res.ok) return null;
        const data = await res.json();
        const people = data?.people || [];
        if (people.length === 0) return null;
        // Tenta achar o match mais próximo por nome
        const target = (fullName || '').toLowerCase();
        const best = people.find(p => (p.name || '').toLowerCase() === target) || people[0];
        return best || null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function normalizeApolloPerson(person) {
    if (!person) return null;
    return {
        apollo_id:      person.id,
        name:           person.name || null,
        first_name:     person.first_name || null,
        last_name:      person.last_name || null,
        title:          person.title || null,
        headline:       person.headline || null,
        email:          person.email || null,
        personal_emails:  Array.isArray(person.personal_emails) ? person.personal_emails : [],
        linkedin_url:   person.linkedin_url || null,
        twitter_url:    person.twitter_url || null,
        github_url:     person.github_url || null,
        phone_numbers:  Array.isArray(person.phone_numbers)
            ? person.phone_numbers.map(p => p.sanitized_number || p.raw_number || p).filter(Boolean)
            : [],
        organization: person.organization ? {
            name:         person.organization.name,
            website_url:  person.organization.website_url,
            linkedin_url: person.organization.linkedin_url,
            industry:     person.organization.industry,
        } : null,
        city:           person.city || null,
        state:          person.state || null,
        country:        person.country || null,
    };
}

export async function enrichPerson({
    name, first_name, last_name,
    email, phone_number,
    organization_name, domain,
    linkedin_url,
    reveal_personal_emails = false,
} = {}) {
    if (!API_KEY) throw new Error('Apollo não configurado (APOLLO_API_KEY ausente).');

    const body = { reveal_personal_emails };
    if (name) body.name = name;
    if (first_name) body.first_name = first_name;
    if (last_name)  body.last_name  = last_name;
    if (email) body.email = email;
    if (phone_number) body.phone_numbers = [phone_number];
    if (organization_name) body.organization_name = organization_name;
    if (domain) body.domain = domain;
    if (linkedin_url) body.linkedin_url = linkedin_url;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    let res;
    try {
        res = await fetch(`${BASE}/people/match`, {
            method:  'POST',
            signal:  ctrl.signal,
            headers: {
                'X-Api-Key':   API_KEY,
                'Content-Type': 'application/json',
                'Accept':      'application/json',
                'Cache-Control': 'no-cache',
            },
            body: JSON.stringify(body),
        });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Apollo timeout — tente novamente');
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        logger.warn('Apollo enrich failed', { status: res.status, body: txt.slice(0, 300) });
        throw new Error(`Apollo erro ${res.status}: ${txt.slice(0, 200) || res.statusText}`);
    }

    const data = await res.json();
    const person = data?.person || null;
    // Se /people/match não achou, tenta /mixed_people/search como fallback
    if (!person) {
        const searchResult = await searchPerson({ name, first_name, last_name, organization_name, domain });
        return normalizeApolloPerson(searchResult);
    }
    return normalizeApolloPerson(person);
}
