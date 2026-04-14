/**
 * Auth Routes — login, logout, me, seed admin
 */
import { Router } from 'express';
import supabase from '../services/supabase.js';
import { hashPassword, verifyPassword, signToken } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ─── POST /api/auth/login ─────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    const { data: user, error } = await supabase
        .from('platform_users')
        .select('id, email, name, role, password_hash, pipedrive_user_id, avatar_url, active')
        .eq('email', email.toLowerCase().trim())
        .single();

    if (error || !user) {
        return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }
    if (!user.active) {
        return res.status(403).json({ error: 'Sua conta está desativada. Fale com o administrador.' });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
        return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    }

    const token = signToken({
        id:                user.id,
        email:             user.email,
        name:              user.name,
        role:              user.role,
        pipedrive_user_id: user.pipedrive_user_id,
        avatar_url:        user.avatar_url,
    });

    res.json({
        token,
        user: {
            id:                user.id,
            email:             user.email,
            name:              user.name,
            role:              user.role,
            pipedrive_user_id: user.pipedrive_user_id,
            avatar_url:        user.avatar_url,
        }
    });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────
router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});

// ─── POST /api/auth/logout ────────────────────────────────────────────
router.post('/auth/logout', (req, res) => {
    res.json({ ok: true });
});

// ─── POST /api/auth/seed-admin ── Cria admin inicial (só se não existir)
router.post('/auth/seed-admin', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
        return res.status(400).json({ error: 'email, password e name são obrigatórios.' });
    }

    // Verifica se já existe algum Admin
    const { count } = await supabase
        .from('platform_users')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'Admin');

    if (count > 0) {
        return res.status(400).json({ error: 'Já existe um Admin cadastrado. Use o painel para gerenciar usuários.' });
    }

    const password_hash = await hashPassword(password);
    const { data, error } = await supabase.from('platform_users').insert({
        email: email.toLowerCase().trim(),
        password_hash,
        name,
        role: 'Admin',
    }).select('id, email, name, role').single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, user: data });
});

export default router;
