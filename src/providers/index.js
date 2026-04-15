/**
 * Provider Factory — Returns the active WhatsApp provider.
 * Switch providers via WHATSAPP_PROVIDER env var (default: unipile).
 */
import unipileProvider from './unipile.js';

const providers = {
    unipile: unipileProvider,
};

export function getProvider(name) {
    const key = name || process.env.WHATSAPP_PROVIDER || 'unipile';
    const provider = providers[key];
    if (!provider) throw new Error(`Unknown WhatsApp provider: ${key}`);
    return provider;
}

export default getProvider();
