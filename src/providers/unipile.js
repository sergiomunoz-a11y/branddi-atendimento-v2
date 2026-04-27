/**
 * Unipile WhatsApp Provider — Concrete implementation
 * Wraps existing Unipile service functions into the provider interface.
 */
import { WhatsAppProvider } from './base.js';

const API_KEY = process.env.UNIPILE_API_KEY;
const DSN     = process.env.UNIPILE_DSN;
const ACCT_ID = process.env.UNIPILE_ACCOUNT_ID;
const BASE    = DSN ? `https://${DSN}/api/v1` : null;

async function req(endpoint, options = {}) {
    if (!API_KEY || !DSN) throw new Error('Unipile not configured');
    const res = await fetch(`${BASE}${endpoint}`, {
        ...options,
        headers: { 'X-API-KEY': API_KEY, 'Accept': 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Unipile (${res.status}): ${err}`);
    }
    return res.json();
}

class UnipileProvider extends WhatsAppProvider {
    constructor() {
        super('unipile');
    }

    isAvailable() {
        return !!(API_KEY && DSN && ACCT_ID);
    }

    async sendMessage(chatId, text) {
        const fd = new FormData();
        fd.append('text', text);
        return req(`/chats/${chatId}/messages`, { method: 'POST', body: fd });
    }

    async startChat(phoneNumber, text) {
        const accountId = ACCT_ID;
        if (!accountId) throw new Error('No WhatsApp account connected');
        const fd = new FormData();
        fd.append('account_id', accountId);
        fd.append('text', text);
        fd.append('attendees_ids', phoneNumber);
        return req('/chats', { method: 'POST', body: fd });
    }

    async listAccounts() {
        return req('/accounts');
    }

    async listChats({ limit = 30, cursor, unread } = {}) {
        let qs = `?account_type=WHATSAPP&limit=${limit}`;
        if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
        if (unread != null) qs += `&unread=${unread}`;
        return req(`/chats${qs}`);
    }

    async getMessages(chatId, { limit = 50, cursor } = {}) {
        let qs = `?limit=${limit}`;
        if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
        return req(`/chats/${chatId}/messages${qs}`);
    }

    async getChatAttendees(chatId) {
        return req(`/chats/${chatId}/attendees`);
    }

    normalizeMessage(raw) {
        let text = raw.text || '';
        let attachments = raw.attachments || [];

        // Unipile devolve "cannot display this type" pra vCard / sticker / áudio /
        // vídeo / localização — mas o conteúdo nativo do WhatsApp vem em raw.original.
        // Aqui parseamos e substituímos por uma label útil + metadata pro front
        // renderizar adequadamente.
        if (text.includes('Unipile cannot display this type')) {
            const enriched = enrichUnsupportedMessage(raw.original);
            if (enriched) {
                text = enriched.text;
                if (enriched.meta) {
                    attachments = [{ type: 'native_meta', kind: enriched.kind, meta: enriched.meta }];
                }
            }
        }

        return {
            id:          raw.id,
            chatId:      raw.chat_id,
            text,
            direction:   raw.is_sender ? 'outbound' : 'inbound',
            senderPhone: raw.sender?.phone_number || null,
            senderName:  raw.sender?.name || null,
            timestamp:   raw.timestamp || raw.created_at,
            attachments,
            // Status de entrega (significativo apenas pra outbound):
            // delivered=1 → ✓✓ cinza | seen=1 → ✓✓ azul (lido)
            delivered:   raw.delivered === 1 || raw.delivered === true,
            seen:        raw.seen === 1 || raw.seen === true,
        };
    }

    normalizeContact(raw) {
        // Phone: specifics.phone_number > public_identifier > raw.phone_number > provider_id (non-lid)
        const phone = raw.specifics?.phone_number
            || raw.phone_number
            || raw.phone
            || (raw.public_identifier && raw.public_identifier.replace(/@.*/, ''))
            || (!String(raw.provider_id || '').includes('@lid') && raw.provider_id)
            || '';

        // Name: se parece telefone (+55...), ignorar — será resolvido depois via Pipedrive
        const rawName = raw.name || null;
        const name = rawName && /^\+?\d[\d\s\-()]+$/.test(rawName.trim()) ? null : rawName;

        return {
            phone,
            name,
            providerId: raw.provider_id || raw.id || null,
        };
    }
}

/**
 * Quando Unipile diz "cannot display this type", o JSON nativo do WhatsApp
 * vem em raw.original. Detecta o tipo e devolve uma label útil em pt-BR.
 */
function enrichUnsupportedMessage(originalStr) {
    if (!originalStr) return null;
    let parsed;
    try { parsed = typeof originalStr === 'string' ? JSON.parse(originalStr) : originalStr; }
    catch { return null; }
    const m = parsed?.message;
    if (!m) return null;

    if (m.contactMessage) {
        const name  = m.contactMessage.displayName || 'Contato';
        const vcard = m.contactMessage.vcard || '';
        const phoneMatch = vcard.match(/TEL[^:]*:([^\s\n]+)/i);
        const phone = phoneMatch ? phoneMatch[1].replace(/^[^+\d]+/, '') : null;
        return {
            text: `📇 Contato compartilhado: ${name}${phone ? ` — ${phone}` : ''}`,
            kind: 'contact',
            meta: { name, phone, vcard },
        };
    }
    if (m.contactsArrayMessage) {
        const list = m.contactsArrayMessage.contacts || [];
        return {
            text: `📇 ${list.length} contatos compartilhados`,
            kind: 'contacts_array',
            meta: { count: list.length },
        };
    }
    if (m.stickerMessage) {
        return { text: '🌟 Figurinha (visualizar no WhatsApp)', kind: 'sticker', meta: {} };
    }
    if (m.audioMessage) {
        const seconds = m.audioMessage.seconds || null;
        return {
            text: `🎵 Áudio${seconds ? ` (${seconds}s)` : ''} — visualizar no WhatsApp`,
            kind: 'audio',
            meta: { seconds },
        };
    }
    if (m.videoMessage) {
        return { text: '🎬 Vídeo (visualizar no WhatsApp)', kind: 'video', meta: {} };
    }
    if (m.locationMessage) {
        const lat = m.locationMessage.degreesLatitude;
        const lng = m.locationMessage.degreesLongitude;
        const url = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : null;
        return {
            text: `📍 Localização compartilhada${url ? ` — ${url}` : ''}`,
            kind: 'location',
            meta: { lat, lng, url },
        };
    }
    if (m.liveLocationMessage) {
        return { text: '📍 Localização em tempo real', kind: 'live_location', meta: {} };
    }
    if (m.pollCreationMessage) {
        const name = m.pollCreationMessage.name || 'Enquete';
        return { text: `📊 Enquete: ${name}`, kind: 'poll', meta: { name } };
    }
    return { text: '📎 Mensagem em formato não suportado', kind: 'unknown', meta: {} };
}

// Singleton
const unipileProvider = new UnipileProvider();
export default unipileProvider;
