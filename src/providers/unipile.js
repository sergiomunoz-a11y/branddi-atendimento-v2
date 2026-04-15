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
        return {
            id:          raw.id,
            chatId:      raw.chat_id,
            text:        raw.text || '',
            direction:   raw.is_sender ? 'outbound' : 'inbound',
            senderPhone: raw.sender?.phone_number || null,
            senderName:  raw.sender?.name || null,
            timestamp:   raw.timestamp || raw.created_at,
            attachments: raw.attachments || [],
        };
    }

    normalizeContact(raw) {
        const phone = raw.phone_number || raw.phone
            || (!String(raw.provider_id || '').includes('@lid') && raw.provider_id)
            || raw.id || '';
        return {
            phone,
            name:       raw.name || null,
            providerId: raw.provider_id || raw.id || null,
        };
    }
}

// Singleton
const unipileProvider = new UnipileProvider();
export default unipileProvider;
