/**
 * Auth Routes — login, logout, me, seed admin
 */
import { Router } from 'express';
import { OAuth2Client } from 'google-auth-library';
import supabase from '../services/supabase.js';
import { hashPassword, verifyPassword, signToken } from '../services/auth.js';
import { requireAuth } from '../middleware/auth.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const ALLOWED_DOMAIN = process.env.GOOGLE_ALLOWED_DOMAIN || 'branddi.com';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const router = Router();

// ─── POST /api/auth/login ─────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    let { data: user, error } = await supabase
        .from('platform_users')
        .select('id, email, name, role, password_hash, pipedrive_user_id, avatar_url, active, permissions')
        .eq('email', email.toLowerCase().trim())
        .single();

    // Fallback if permissions column doesn't exist yet
    if (error?.code === '42703') {
        const retry = await supabase
            .from('platform_users')
            .select('id, email, name, role, password_hash, pipedrive_user_id, avatar_url, active')
            .eq('email', email.toLowerCase().trim())
            .single();
        user = retry.data;
        error = retry.error;
        if (user) user.permissions = {};
    }

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

    const permissions = user.permissions || {};

    const token = signToken({
        id:                user.id,
        email:             user.email,
        name:              user.name,
        role:              user.role,
        pipedrive_user_id: user.pipedrive_user_id,
        avatar_url:        user.avatar_url,
        permissions,
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
            permissions,
        }
    });
});

// ─── POST /api/auth/google — Login via Google OAuth ──────────────────
router.post('/auth/google', async (req, res) => {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Token do Google e obrigatorio' });
    if (!googleClient) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID nao configurado no servidor' });

    try {
        // Verifica o token do Google
        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        const { sub: googleId, email, name, picture, hd } = payload;

        // Restringe ao dominio permitido
        if (ALLOWED_DOMAIN && hd !== ALLOWED_DOMAIN) {
            return res.status(403).json({ error: `Apenas contas @${ALLOWED_DOMAIN} sao permitidas.` });
        }

        // Busca user existente por google_id ou email
        let { data: user } = await supabase
            .from('platform_users')
            .select('id, email, name, role, pipedrive_user_id, avatar_url, active, permissions, google_id')
            .or(`google_id.eq.${googleId},email.eq.${email.toLowerCase()}`)
            .limit(1)
            .single();

        if (user && !user.active) {
            return res.status(403).json({ error: 'Sua conta esta desativada. Fale com o administrador.' });
        }

        if (!user) {
            // Primeiro login — cria user com role SDR
            const pw = await hashPassword(`google_${googleId}_${Date.now()}`);
            const { data: newUser, error: createErr } = await supabase.from('platform_users').insert({
                email: email.toLowerCase(),
                name: name || email.split('@')[0],
                password_hash: pw,
                role: 'SDR',
                google_id: googleId,
                avatar_url: picture || null,
                permissions: {},
            }).select('id, email, name, role, pipedrive_user_id, avatar_url, permissions').single();

            if (createErr) return res.status(500).json({ error: createErr.message });
            user = newUser;
        } else {
            // Atualiza google_id e avatar se necessario
            const updates = {};
            if (!user.google_id) updates.google_id = googleId;
            if (picture && !user.avatar_url) updates.avatar_url = picture;
            if (Object.keys(updates).length > 0) {
                updates.updated_at = new Date().toISOString();
                await supabase.from('platform_users').update(updates).eq('id', user.id);
                if (updates.avatar_url) user.avatar_url = updates.avatar_url;
            }
        }

        const permissions = user.permissions || {};
        const token = signToken({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            pipedrive_user_id: user.pipedrive_user_id,
            avatar_url: user.avatar_url,
            permissions,
        });

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                pipedrive_user_id: user.pipedrive_user_id,
                avatar_url: user.avatar_url,
                permissions,
            },
        });
    } catch (err) {
        res.status(401).json({ error: 'Token do Google invalido: ' + err.message });
    }
});

// ─── GET /api/auth/google-client-id — Retorna client ID para o frontend
router.get('/auth/google-client-id', (req, res) => {
    res.json({ client_id: GOOGLE_CLIENT_ID || null });
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
