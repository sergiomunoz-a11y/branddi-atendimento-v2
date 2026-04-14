/**
 * Auth Middleware — valida JWT e injeta req.user
 */
import { verifyToken } from '../services/auth.js';
import logger from '../services/logger.js';

/** Rotas públicas que NÃO precisam de auth (sem prefixo /api — middleware montado em /api) */
const PUBLIC_PATHS = [
    '/health',
    '/auth/login',
    '/auth/seed-admin',
];

export function requireAuth(req, res, next) {
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

    req.user = payload;
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
