/**
 * Branddi Atendimento v2 — Server Principal
 * Porta 3838 | WhatsApp Inbox + Chatbot + CRM Sync
 * v2: Rate limiting, CORS seguro, structured logging, health antes de auth
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import logger from './services/logger.js';

import webhooksRouter          from './routes/webhooks.js';
import inboxRouter             from './routes/inbox.js';
import messagesRouter          from './routes/messages.js';
import leadsRouter             from './routes/leads.js';
import dashboardRouter         from './routes/dashboard.js';
import scriptsRouter           from './routes/scripts.js';
import whatsappAccountsRouter  from './routes/whatsapp-accounts.js';
import settingsRouter          from './routes/settings.js';
import authRouter              from './routes/auth.js';
import usersRouter             from './routes/users.js';
import pipedriveIntRouter      from './routes/pipedrive-integration.js';
import { requireAuth }         from './middleware/auth.js';

import chatbotRouter               from './routes/chatbot.js';
import simulateRouter              from './routes/simulate.js';
import { startPolling }            from './services/unipile.js';
import { startCrmSyncWorker }      from './services/crm-sync.js';
import { startChatbotWorkers }     from './services/chatbot-workers.js';
import { getPipedriveCircuitStatus } from './services/pipedrive.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3838;

// ─── CORS ────────────────────────────────────────────────────────────
const corsOrigin = process.env.NODE_ENV === 'production'
    ? (process.env.FRONTEND_URL || (() => { throw new Error('FRONTEND_URL required in production'); })())
    : (process.env.FRONTEND_URL || '*');

// ─── Middleware ───────────────────────────────────────────────────────
app.use(compression());
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(join(__dirname, '..', 'public')));

// ─── Rate Limiting ───────────────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    message: { error: 'Muitas tentativas de login. Aguarde 1 minuto.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const webhookLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    message: { error: 'Rate limit exceeded' },
    standardHeaders: true,
    legacyHeaders: false,
});

const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 100,
    message: { error: 'Muitas requisições. Aguarde um momento.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Aplica rate limiters
app.use('/api/auth/login', loginLimiter);
app.use('/api/webhooks', webhookLimiter);
app.use('/api', apiLimiter);

// ─── Health Check (ANTES do auth — rota pública) ─────────────────────
let _healthCache = { data: null, ts: 0 };
const HEALTH_TTL = 60_000;

app.get('/api/health', async (req, res) => {
    const now = Date.now();
    if (_healthCache.data && (now - _healthCache.ts) < HEALTH_TTL) {
        return res.json({ ..._healthCache.data, timestamp: new Date().toISOString(), uptime_s: Math.floor(process.uptime()) });
    }

    let waConnected = false;
    let waStatus    = 'unknown';

    try {
        const DSN     = process.env.UNIPILE_DSN;
        const API_KEY = process.env.UNIPILE_API_KEY;
        const ACCT_ID = process.env.UNIPILE_ACCOUNT_ID;

        if (DSN && API_KEY && ACCT_ID) {
            const r = await fetch(`https://${DSN}/api/v1/accounts/${ACCT_ID}`, {
                headers: { 'X-API-KEY': API_KEY },
                signal:  AbortSignal.timeout(5000)
            });
            if (r.ok) {
                const acc = await r.json();
                waStatus    = acc.connection_status || acc.status || 'unknown';
                waConnected = (waStatus === 'OK' || waStatus === 'CONNECTED');
            }
        }
    } catch {
        waConnected = false;
        waStatus    = 'error';
    }

    const result = {
        status:    'ok',
        service:   'branddi-atendimento',
        version:   '2.0.0',
        timestamp: new Date().toISOString(),
        uptime_s:  Math.floor(process.uptime()),
        services: {
            unipile:   waConnected,
            waStatus,
            pipedrive: !!(process.env.PIPEDRIVE_API_TOKEN),
            pipedrive_circuit: getPipedriveCircuitStatus(),
            supabase:  !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY),
        }
    };

    _healthCache = { data: result, ts: now };
    res.json(result);
});

// ─── Rotas públicas (antes do middleware de auth) ─────────────────────
app.use('/api', authRouter);
app.use('/api', webhooksRouter);

// ─── Middleware global de autenticação ────────────────────────────────
app.use('/api', requireAuth);

// ─── Rotas protegidas ─────────────────────────────────────────────────
app.use('/api', simulateRouter);  // Simulador do bot (agora protegido)
app.use('/api', inboxRouter);
app.use('/api', messagesRouter);
app.use('/api', leadsRouter);
app.use('/api', dashboardRouter);
app.use('/api', scriptsRouter);
app.use('/api', whatsappAccountsRouter);
app.use('/api', settingsRouter);
app.use('/api', usersRouter);
app.use('/api', pipedriveIntRouter);
app.use('/api', chatbotRouter);

// ─── SPA Fallback — serve index.html para rotas não-API ──────────────
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    logger.info('Branddi Atendimento v2.0.0 iniciado', { port: PORT });

    try { startPolling(); } catch (err) {
        logger.warn('WhatsApp polling não iniciado', { error: err.message });
    }

    startCrmSyncWorker();
    startChatbotWorkers();
});

export default app;
