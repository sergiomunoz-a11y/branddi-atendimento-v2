/**
 * Auth Middleware — valida JWT e hidrata req.user com dados vivos do DB.
 *
 * Por que isso: JWT é imutável até expirar. Se um admin muda permissões/role
 * de um user, a alteração só surtiria efeito após logout+login. Aqui fazemos
 * lookup no platform_users a cada request (com cache in-memory curto) para
 * refletir mudanças em segundos, sem invalidar sessões.
 *
 * Cache TTL: 30s. Balanceia fresco vs carga no Supabase.
 * Chave: user.id.
 */
import { verifyToken } from '../services/auth.js';
import supabase from '../services/supabase.js';
import logger from './../services/logger.js';

/** Rotas públicas que NÃO precisam de auth (sem prefixo /api — middleware montado em /api) */
const PUBLIC_PATHS = [
    '/health',
    '/auth/login',
    '/auth/google',
    '/auth/google-client-id',
    '/auth/seed-admin',
    '/auth/logout',
];

// ─── Cache de permissões por user.id ─────────────────────────────────
const USER_CACHE_TTL_MS = 30_000;
const _userCache = new Map(); // id → { data, expiresAt }

/** Invalida cache de um user — chamado quando admin atualiza permissions/role. */
export function invalidateUserCache(userId) {
    if (!userId) return;
    _userCache.delete(userId);
}

/** Invalida cache de todos os users. */
export function invalidateAllUserCache() {
    _userCache.clear();
}

async function loadFreshUser(userId) {
    const cached = _userCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }

    const { data, error } = await supabase
        .from('platform_users')
        .select('id, email, name, role, pipedrive_user_id, avatar_url, active, permissions')
        .eq('id', userId)
        .single();

    if (error || !data) {
        return null;
    }

    const fresh = {
        id:                data.id,
        email:             data.email,
        name:              data.name,
        role:              data.role,
        pipedrive_user_id: data.pipedrive_user_id,
        avatar_url:        data.avatar_url,
        active:            data.active,
        permissions:       data.permissions || {},
    };

    _userCache.set(userId, { data: fresh, expiresAt: Date.now() + USER_CACHE_TTL_MS });
    return fresh;
}

export async function requireAuth(req, res, next) {
    // Rotas públicas passam direto
    if (PUBLIC_PATHS.some(p => req.path === p)) return next();
    // Webhooks e simulador passam direto
    if (req.path.startsWith('/webhooks')) return next();
    if (req.path.startsWith('/simulate')) return next();

    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Não autenticado. Faça login.' });
    }

    const payload = verifyToken(token);
    if (!payload) {
        logger.warn('Token inválido ou expirado', { path: req.path });
        return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }

    // Hidrata req.user com dados frescos do DB (role + permissions + active).
    // Falhas de DB: fallback silencioso pro payload (resilência).
    try {
        const fresh = await loadFreshUser(payload.id);
        if (!fresh) {
            // User deletado ou não encontrado — invalida sessão
            return res.status(401).json({ error: 'Usuário não encontrado. Faça login novamente.' });
        }
        if (fresh.active === false) {
            return res.status(403).json({ error: 'Sua conta foi desativada. Fale com o administrador.' });
        }
        req.user = fresh;
    } catch (err) {
        logger.warn('Auth hydrate failed, falling back to JWT payload', { error: err.message, user_id: payload.id });
        req.user = payload;
    }

    next();
}

/** Cria middleware que exige um ou mais roles específicos */
export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Não autenticado.' });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                error: `Acesso negado. Seu perfil (${req.user.role}) não tem permissão para isso.`
            });
        }
        next();
    };
}

function extractToken(req) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    return req.cookies?.token || null;
}
