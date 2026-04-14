/**
 * WhatsApp Account Routes — Gerencia conexão via QR Code
 * Espelha a lógica validada no prospecting-engine-v2
 */
import { Router } from 'express';

const router = Router();

// ─── Helpers Unipile ──────────────────────────────────────────────────

function getUnipileConfig() {
    const key = process.env.UNIPILE_API_KEY;
    const dsn  = process.env.UNIPILE_DSN;
    if (!key || !dsn) return null;
    return { key, base: `https://${dsn}/api/v1` };
}

async function unipileFetch(endpoint, options = {}, timeoutMs = 10000) {
    const config = getUnipileConfig();
    if (!config) throw new Error('Unipile não configurado (UNIPILE_API_KEY / UNIPILE_DSN ausentes)');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${config.base}${endpoint}`, {
            ...options,
            signal: controller.signal,
            headers: {
                'X-API-KEY': config.key,
                'Accept':    'application/json',
                ...(options.headers || {}),
            },
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Unipile API error (${res.status}): ${err}`);
        }
        return res.json();
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`Timeout (${timeoutMs/1000}s) — Unipile não respondeu`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ─── GET /api/whatsapp/accounts — Lista contas conectadas ─────────────
router.get('/whatsapp/accounts', async (req, res) => {
    try {
        const config = getUnipileConfig();
        console.log('[WA] Listing accounts. Config:', config ? `base=${config.base}` : 'NOT CONFIGURED');

        const data = await unipileFetch('/accounts', {}, 8000);
        const all = data.items || (Array.isArray(data) ? data : []);
        console.log('[WA] Raw accounts:', JSON.stringify(all.slice(0,3)));

        const accounts = all.filter(
            a => (a.type || '').toUpperCase() === 'WHATSAPP' || (a.provider || '').toUpperCase() === 'WHATSAPP'
        );
        res.json({ accounts });
    } catch (err) {
        console.warn('[WA] Accounts error:', err.message);
        res.json({ accounts: [], error: err.message });
    }
});

// ─── POST /api/whatsapp/connect — Inicia conexão (retorna QR Code) ────
// A Unipile pode demorar até ~25s para retornar o checkpoint com o QR.
// Usamos timeout de 35s para garantir.
router.post('/whatsapp/connect', async (req, res) => {
    console.log('[WA] Iniciando conexão WhatsApp via Unipile...');
    try {
        const result = await unipileFetch('/accounts', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ provider: 'WHATSAPP' }),
        }, 35000); // 35s de timeout para o QR

        console.log('[WA] Connect result object:', result?.object, '| checkpoint type:', result?.checkpoint?.type);
        res.json(result);
    } catch (err) {
        console.error('[WA] Connect error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /api/whatsapp/accounts/:id — Desconecta conta ────────────
router.delete('/whatsapp/accounts/:id', async (req, res) => {
    try {
        await unipileFetch(`/accounts/${req.params.id}`, { method: 'DELETE' }, 8000);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
