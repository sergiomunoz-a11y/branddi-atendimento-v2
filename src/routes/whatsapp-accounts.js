/**
 * WhatsApp Account Routes — Gerencia conexao via QR Code + controle de acesso
 *
 * Regras de acesso:
 * - Admin ve e usa todas as contas
 * - Quando user conecta numero novo → fica disponivel so pra ele + Admin
 * - Admin pode autorizar outros users via permissions.whatsapp_accounts
 */
import { Router } from 'express';
import supabase from '../services/supabase.js';
import { invalidateUserCache } from '../middleware/auth.js';
import logger from '../services/logger.js';

const router = Router();

// ─── Helpers Unipile ──────────────────────────────────────────────────

function getUnipileConfig() {
    const key = process.env.UNIPILE_API_KEY;
    const dsn = process.env.UNIPILE_DSN;
    if (!key || !dsn) return null;
    return { key, base: `https://${dsn}/api/v1` };
}

async function unipileFetch(endpoint, options = {}, timeoutMs = 10000) {
    const config = getUnipileConfig();
    if (!config) throw new Error('Unipile nao configurado');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${config.base}${endpoint}`, {
            ...options,
            signal: controller.signal,
            headers: {
                'X-API-KEY': config.key,
                'Accept': 'application/json',
                ...(options.headers || {}),
            },
        });
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Unipile (${res.status}): ${err}`);
        }
        return res.json();
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`Timeout — Unipile nao respondeu`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ─── GET /api/whatsapp/accounts — Lista contas com controle de acesso ─
router.get('/whatsapp/accounts', async (req, res) => {
    try {
        const data = await unipileFetch('/accounts', {}, 8000);
        const all = data.items || (Array.isArray(data) ? data : []);

        let accounts = all.filter(
            a => (a.type || '').toUpperCase() === 'WHATSAPP' || (a.provider || '').toUpperCase() === 'WHATSAPP'
        );

        // Sync com tabela local whatsapp_accounts
        for (const acc of accounts) {
            await syncAccountToLocal(acc);
        }

        // Busca registros locais para enriquecer com connected_by info
        const { data: localAccounts } = await supabase
            .from('whatsapp_accounts')
            .select('unipile_account_id, phone_number, label, connected_by_user_id, status');

        const localMap = {};
        for (const la of (localAccounts || [])) {
            localMap[la.unipile_account_id] = la;
        }

        // Filtra por permissao
        const user = req.user || {};
        const isAdmin = user.role === 'Admin';
        const permissions = user.permissions || {};
        const allowedIds = permissions.whatsapp_accounts || [];

        const enriched = accounts.map(a => {
            const local = localMap[a.id] || {};
            // Unipile retorna o status detalhado em sources[].status ("OK" quando conectado).
            // Os campos top-level connection_status/status vêm vazios no endpoint /accounts.
            const sourceStatus = Array.isArray(a.sources) && a.sources.length > 0
                ? a.sources[0].status
                : null;
            return {
                id: a.id,
                phone_number: a.connection_params?.im?.phone_number || local.phone_number || null,
                name: a.name || local.label || null,
                status: a.connection_status || a.status || sourceStatus || local.status || 'unknown',
                connected_by_user_id: local.connected_by_user_id || null,
                is_mine: local.connected_by_user_id === user.id,
            };
        });

        // Admin ve tudo. User ve: suas proprias + autorizadas via permissions
        let filtered = enriched;
        if (!isAdmin) {
            filtered = enriched.filter(a =>
                a.is_mine || allowedIds.includes(a.id)
            );
        }

        res.json({ accounts: filtered });
    } catch (err) {
        logger.warn('WA accounts error', { error: err.message });
        res.json({ accounts: [], error: err.message });
    }
});

// ─── POST /api/whatsapp/connect — Conecta novo numero (QR Code) ──────
router.post('/whatsapp/connect', async (req, res) => {
    try {
        const result = await unipileFetch('/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: 'WHATSAPP' }),
        }, 35000);

        // Se a conta foi criada, registra localmente vinculada ao user
        const accountId = result?.account_id || result?.id;
        if (accountId) {
            await supabase.from('whatsapp_accounts').upsert({
                unipile_account_id: accountId,
                connected_by_user_id: req.user?.id || null,
                phone_number: result?.connection_params?.im?.phone_number || null,
                label: req.user?.name ? `${req.user.name}` : null,
                status: 'connecting',
                updated_at: new Date().toISOString(),
            }, { onConflict: 'unipile_account_id' });

            // Auto-adiciona nas permissoes do user que conectou
            if (req.user?.id) {
                await addAccountToUserPermissions(req.user.id, accountId);
            }
        }

        res.json(result);
    } catch (err) {
        logger.error('WA connect error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /api/whatsapp/accounts/:id — Desconecta conta ────────────
router.delete('/whatsapp/accounts/:id', async (req, res) => {
    try {
        await unipileFetch(`/accounts/${req.params.id}`, { method: 'DELETE' }, 8000);

        // Atualiza registro local
        await supabase
            .from('whatsapp_accounts')
            .update({ status: 'disconnected', updated_at: new Date().toISOString() })
            .eq('unipile_account_id', req.params.id);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Helpers ──────────────────────────────────────────────────────────

async function syncAccountToLocal(acc) {
    try {
        const phone = acc.connection_params?.im?.phone_number || null;
        const sourceStatus = Array.isArray(acc.sources) && acc.sources.length > 0
            ? acc.sources[0].status
            : null;
        await supabase.from('whatsapp_accounts').upsert({
            unipile_account_id: acc.id,
            phone_number: phone,
            status: acc.connection_status || acc.status || sourceStatus || 'unknown',
            updated_at: new Date().toISOString(),
        }, { onConflict: 'unipile_account_id', ignoreDuplicates: false });
    } catch { /* sync nao critico */ }
}

async function addAccountToUserPermissions(userId, accountId) {
    try {
        const { data: user } = await supabase
            .from('platform_users')
            .select('permissions')
            .eq('id', userId)
            .single();

        const perms = user?.permissions || {};
        const waAccounts = perms.whatsapp_accounts || [];
        if (!waAccounts.includes(accountId)) {
            waAccounts.push(accountId);
            perms.whatsapp_accounts = waAccounts;
            await supabase
                .from('platform_users')
                .update({ permissions: perms, updated_at: new Date().toISOString() })
                .eq('id', userId);
            // Cache do middleware precisa cair fora pra a nova permissão valer já
            invalidateUserCache(userId);
        }
    } catch { /* nao critico */ }
}

export default router;
