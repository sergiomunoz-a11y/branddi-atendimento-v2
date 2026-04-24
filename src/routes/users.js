/**
 * Users Routes — CRUD de usuários (Admin only)
 * v2: Adiciona validação de email, password, name e role
 */
import { Router } from 'express';
import supabase from '../services/supabase.js';
import { hashPassword } from '../services/auth.js';
import { requireAuth, requireRole, invalidateUserCache } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();
const adminOnly = [requireAuth, requireRole('Admin')];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ['Usuario', 'Admin'];

// ─── GET /api/users — lista todos os usuários ─────────────────────────
router.get('/users', ...adminOnly, async (req, res) => {
    let { data, error } = await supabase
        .from('platform_users')
        .select('id, email, name, role, pipedrive_user_id, pipedrive_api_token, avatar_url, active, permissions, created_at')
        .order('created_at', { ascending: true });

    // Fallback if columns don't exist yet
    if (error?.code === '42703') {
        const retry = await supabase
            .from('platform_users')
            .select('id, email, name, role, pipedrive_user_id, avatar_url, active, created_at')
            .order('created_at', { ascending: true });
        data = (retry.data || []).map(u => ({ ...u, permissions: {}, pipedrive_api_token: null }));
        error = retry.error;
    }

    if (error) return res.status(500).json({ error: error.message });

    // Mascarar tokens — mostra só os últimos 6 chars para o admin saber se está preenchido
    const masked = (data || []).map(u => ({
        ...u,
        pipedrive_api_token: u.pipedrive_api_token
            ? `***${u.pipedrive_api_token.slice(-6)}`
            : null,
    }));

    res.json({ users: masked });
});

// ─── POST /api/users — cria novo usuário ─────────────────────────────
router.post('/users', ...adminOnly, async (req, res) => {
    const err = validate(req.body, {
        email:    { required: true, type: 'string', pattern: EMAIL_REGEX, maxLength: 200 },
        password: { required: true, type: 'string', minLength: 6, maxLength: 200 },
        name:     { required: true, type: 'string', maxLength: 200 },
        role:     { required: true, type: 'string', enum: VALID_ROLES },
    });
    if (err) return res.status(400).json({ error: err });

    const { email, password, name, role, pipedrive_user_id, permissions, pipedrive_api_token } = req.body;

    const password_hash = await hashPassword(password);
    const insert = {
        email: email.toLowerCase().trim(),
        password_hash,
        name,
        role,
        pipedrive_user_id: pipedrive_user_id || null,
        permissions: permissions || {},
    };
    if (pipedrive_api_token) insert.pipedrive_api_token = pipedrive_api_token;

    const { data, error } = await supabase.from('platform_users').insert(insert)
        .select('id, email, name, role, pipedrive_user_id, permissions, active').single();

    if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
        return res.status(500).json({ error: error.message });
    }
    res.status(201).json({ user: data });
});

// ─── PATCH /api/users/:id — edita usuário ────────────────────────────
router.patch('/users/:id', ...adminOnly, async (req, res) => {
    const { name, role, pipedrive_user_id, active, password, permissions, pipedrive_api_token } = req.body;

    // Validação condicional dos campos fornecidos
    const rules = {};
    if (name !== undefined)     rules.name     = { type: 'string', maxLength: 200 };
    if (role !== undefined)     rules.role     = { type: 'string', enum: VALID_ROLES };
    if (password !== undefined) rules.password = { type: 'string', minLength: 6, maxLength: 200 };

    if (Object.keys(rules).length > 0) {
        const err = validate(req.body, rules);
        if (err) return res.status(400).json({ error: err });
    }

    const updates = {};
    if (name !== undefined)              updates.name              = name;
    if (role !== undefined)              updates.role              = role;
    if (pipedrive_user_id !== undefined) updates.pipedrive_user_id = pipedrive_user_id;
    if (active !== undefined)            updates.active            = active;
    if (permissions !== undefined)       updates.permissions       = permissions;
    if (pipedrive_api_token !== undefined) updates.pipedrive_api_token = pipedrive_api_token || null;
    if (password)                        updates.password_hash     = await hashPassword(password);
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
        .from('platform_users')
        .update(updates)
        .eq('id', req.params.id)
        .select('id, email, name, role, pipedrive_user_id, permissions, active')
        .single();

    if (error) return res.status(500).json({ error: error.message });
    // Invalida cache do user editado — a próxima request dele pega permissões/role atualizados
    invalidateUserCache(req.params.id);
    res.json({ user: data });
});

// ─── DELETE /api/users/:id — desativa (não apaga) ────────────────────
router.delete('/users/:id', ...adminOnly, async (req, res) => {
    // Não apaga — só desativa para preservar histórico
    const { error } = await supabase
        .from('platform_users')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    invalidateUserCache(req.params.id);
    res.json({ ok: true });
});

// ─── DELETE /api/users/:id/permanent — apaga do banco (irreversível) ──
// Só funciona se o user já estiver desativado (active=false). Protege contra
// apagar acidentalmente um user ativo. Admin não pode apagar a si mesmo.
router.delete('/users/:id/permanent', ...adminOnly, async (req, res) => {
    const id = req.params.id;
    if (id === req.user?.id) {
        return res.status(400).json({ error: 'Você não pode apagar seu próprio usuário.' });
    }

    const { data: user, error: getErr } = await supabase
        .from('platform_users')
        .select('id, email, name, active')
        .eq('id', id)
        .maybeSingle();
    if (getErr) return res.status(500).json({ error: getErr.message });
    if (!user)  return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.active) {
        return res.status(400).json({ error: 'Desative o usuário primeiro antes de apagar permanentemente.' });
    }

    // Checa se tem dados críticos vinculados que restringem o DELETE
    const [conv, wa, scripts] = await Promise.all([
        supabase.from('conversations').select('id', { count: 'exact', head: true }).eq('assigned_user_id', id),
        supabase.from('whatsapp_accounts').select('unipile_account_id', { count: 'exact', head: true }).eq('connected_by_user_id', id),
        supabase.from('scripts').select('id', { count: 'exact', head: true }).eq('owner_user_id', id),
    ]);
    const blockers = [];
    if (conv.count)    blockers.push(`${conv.count} conversa(s) atribuída(s)`);
    if (wa.count)      blockers.push(`${wa.count} número(s) WhatsApp`);
    if (scripts.count) blockers.push(`${scripts.count} script(s)`);
    if (blockers.length > 0) {
        return res.status(409).json({
            error: `Não é possível apagar — o usuário tem: ${blockers.join(', ')}. Reatribua antes.`,
        });
    }

    const { error } = await supabase.from('platform_users').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    invalidateUserCache(id);
    res.json({ ok: true, deleted: { id: user.id, email: user.email, name: user.name } });
});

// ─── GET /api/users/pipedrive-users — lista usuários do Pipedrive ────
// Útil para o admin vincular um platform_user ao seu pipedrive_user_id
router.get('/users/pipedrive-users', ...adminOnly, async (req, res) => {
    try {
        const { pdGet } = await import('../services/pipedrive.js');
        const data = await pdGet('/users');
        const users = (data.data || [])
            .filter(u => u.active_flag)
            .map(u => ({ id: u.id, name: u.name, email: u.email }));
        res.json({ users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
