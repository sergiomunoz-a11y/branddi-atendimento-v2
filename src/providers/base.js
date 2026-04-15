/**
 * WhatsApp Provider — Abstract base class
 * Inspired by WhatsApp AgentKit's provider pattern.
 * Enables swapping Unipile for other providers (Meta Cloud API, Twilio, etc.)
 * without touching conversation logic.
 */

export class WhatsAppProvider {
    constructor(name) {
        this.name = name;
    }

    /** Send a text message to a chat */
    async sendMessage(chatId, text) {
        throw new Error(`${this.name}: sendMessage not implemented`);
    }

    /** Start a new chat with a phone number */
    async startChat(phoneNumber, text) {
        throw new Error(`${this.name}: startChat not implemented`);
    }

    /** List connected WhatsApp accounts */
    async listAccounts() {
        throw new Error(`${this.name}: listAccounts not implemented`);
    }

    /** List recent chats */
    async listChats(options = {}) {
        throw new Error(`${this.name}: listChats not implemented`);
    }

    /** Get messages from a chat */
    async getMessages(chatId, options = {}) {
        throw new Error(`${this.name}: getMessages not implemented`);
    }

    /** Get chat attendees/contacts */
    async getChatAttendees(chatId) {
        throw new Error(`${this.name}: getChatAttendees not implemented`);
    }

    /** Check if provider is configured and available */
    isAvailable() {
        return false;
    }

    /**
     * Normalize incoming webhook/poll payload to canonical message format:
     * { id, chatId, text, direction, senderPhone, senderName, timestamp, attachments }
     */
    normalizeMessage(raw) {
        throw new Error(`${this.name}: normalizeMessage not implemented`);
    }

    /**
     * Normalize contact data to canonical format:
     * { phone, name, providerId }
     */
    normalizeContact(raw) {
        throw new Error(`${this.name}: normalizeContact not implemented`);
    }
}
