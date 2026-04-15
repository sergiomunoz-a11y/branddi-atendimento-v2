/**
 * Users Routes — CRUD de usuários (Admin only)
 * v2: Adiciona validação de email, password, name e role
 */
import { Router } from 'express';
import supabase from '../services/supabase.js';
import { hashPassword } from '../services/auth.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();
const adminOnly = [requireAuth, requireRole('Admin')];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ['SDR', 'Closer', 'Admin'];

// ─── GET /api/users — lista todos os usuários ─────────────────────────
router.get('/users', ...adminOnly, async (req, res) => {
    let { data, error } = await supabase
        .from('platform_users')
        .select('id, email, name, role, pipedrive_user_id, avatar_url, active, permissions, created_at')
        .order('created_at', { ascending: true });

    // Fallback if permissions column doesn't exist yet
    if (error?.code === '42703') {
        const retry = await supabase
            .from('platform_users')
            .select('id, email, name, role, pipedrive_user_id, avatar_url, active, created_at')
            .order('created_at', { ascending: true });
        data = (retry.data || []).map(u => ({ ...u, permissions: {} }));
        error = retry.error;
    }

    if (error) return res.status(500).json({ error: error.message });
    res.json({ users: data });
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

    const { email, password, name, role, pipedrive_user_id, permissions } = req.body;

    const password_hash = await hashPassword(password);
    const { data, error } = await supabase.from('platform_users').insert({
        email: email.toLowerCase().trim(),
        password_hash,
        name,
        role,
        pipedrive_user_id: pipedrive_user_id || null,
        permissions: permissions || {},
    }).select('id, email, name, role, pipedrive_user_id, permissions, active').single();

    if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
        return res.status(500).json({ error: error.message });
    }
    res.status(201).json({ user: data });
});

// ─── PATCH /api/users/:id — edita usuário ────────────────────────────
router.patch('/users/:id', ...adminOnly, async (req, res) => {
    const { name, role, pipedrive_user_id, active, password, permissions } = req.body;

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
    if (password)                        updates.password_hash     = await hashPassword(password);
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
        .from('platform_users')
        .update(updates)
        .eq('id', req.params.id)
        .select('id, email, name, role, pipedrive_user_id, permissions, active')
        .single();

    if (error) return res.status(500).json({ error: error.message });
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
    res.json({ ok: true });
});

// ─── GET /api/users/pipedrive-users — lista usuários do Pipedrive ────
// Útil para o admin vincular um platform_user ao seu pipedrive_user_id
router.get('/users/pipedrive-users', ...adminOnly, async (req, res) => {
    try {
        const base = `https://${process.env.PIPEDRIVE_DOMAIN}/api/v1`;
        const r = await fetch(`${base}/users?api_token=${process.env.PIPEDRIVE_API_TOKEN}`);
        const data = await r.json();
        const users = (data.data || [])
            .filter(u => u.active_flag)
            .map(u => ({ id: u.id, name: u.name, email: u.email }));
        res.json({ users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
