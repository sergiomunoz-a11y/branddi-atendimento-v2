/**
 * Chatbot Routes — Analytics, configuração e FAQ management
 *
 * GET  /api/chatbot/analytics    — Métricas de funnel e performance
 * GET  /api/chatbot/analytics/funnel — Funil detalhado por estágio
 * GET  /api/chatbot/faq          — Lista FAQs configuráveis
 * POST /api/chatbot/faq          — Adiciona/atualiza FAQ custom
 * GET  /api/chatbot/config       — Configuração do bot
 * POST /api/chatbot/config       — Atualiza configuração do bot
 */
import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { getSettingValue, saveSetting } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import { BUILTIN_FAQS } from '../services/chatbot-faq.js';
import { WORKER_DEFAULTS } from '../services/chatbot-workers.js';

const router = Router();

// ─── GET /api/chatbot/analytics ──────────────────────────────────────
// Métricas gerais do bot nos últimos N dias.
router.get('/chatbot/analytics', async (req, res) => {
    try {
        const days = parseInt(req.query.days || '30');
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        // Busca eventos do bot
        const { data: events, error: evError } = await supabase
            .from('chatbot_events')
            .select('event_type, metadata, created_at')
            .gte('created_at', since);

        // Busca conversas do período
        const { data: convs } = await supabase
            .from('conversations')
            .select('id, chatbot_stage, chatbot_answers, status, assigned_to, created_at')
            .gte('created_at', since);

        const allEvents = events || [];
        const allConvs = convs || [];

        // Contadores de eventos
        const eventCounts = {};
        for (const e of allEvents) {
            eventCounts[e.event_type] = (eventCounts[e.event_type] || 0) + 1;
        }

        // Funnel: quantas conversas passaram por cada estágio
        const stageDistribution = {};
        for (const c of allConvs) {
            const stage = c.chatbot_stage || 'unknown';
            stageDistribution[stage] = (stageDistribution[stage] || 0) + 1;
        }

        // Classificações
        const classifications = {};
        for (const c of allConvs) {
            const cls = c.chatbot_answers?.intent || c.assigned_to || 'unclassified';
            classifications[cls] = (classifications[cls] || 0) + 1;
        }

        // FAQs mais respondidas
        const faqEvents = allEvents.filter(e => e.event_type === 'faq_answered');
        const faqCounts = {};
        for (const e of faqEvents) {
            const id = e.metadata?.faq_id || 'unknown';
            faqCounts[id] = (faqCounts[id] || 0) + 1;
        }

        // Taxa de escalação
        const escalations = allEvents.filter(e => e.event_type === 'escalated').length;
        const totalClassified = allEvents.filter(e => e.event_type === 'classified').length;
        const escalationRate = totalClassified > 0
            ? Math.round(escalations / (totalClassified + escalations) * 100)
            : 0;

        // Tempo médio no bot (from welcome to classified)
        const classifiedEvents = allEvents.filter(e => e.event_type === 'classified');
        const welcomeEvents = allEvents.filter(e => e.event_type === 'welcome_sent');
        // Approximate: pode usar created_at do primeiro e último evento por conversa

        // Nudges e follow-ups
        const nudges = eventCounts['nudge_sent'] || 0;
        const followups = eventCounts['followup_sent'] || 0;
        const awayMsgs = eventCounts['away_message_sent'] || 0;

        res.json({
            period_days: days,
            totals: {
                conversations: allConvs.length,
                classified: totalClassified,
                escalated: escalations,
                faq_answered: faqEvents.length,
                nudges,
                followups,
                away_messages: awayMsgs,
            },
            rates: {
                escalation: escalationRate,
                classification: allConvs.length > 0
                    ? Math.round(totalClassified / allConvs.length * 100) : 0,
                faq_resolution: allConvs.length > 0
                    ? Math.round(faqEvents.length / allConvs.length * 100) : 0,
            },
            funnel: stageDistribution,
            classifications,
            faq_top: faqCounts,
            events: eventCounts,
        });
    } catch (err) {
        // Se tabela não existe, retorna dados vazios
        if (err.message?.includes('does not exist')) {
            return res.json({
                period_days: 30,
                totals: {}, rates: {}, funnel: {},
                classifications: {}, faq_top: {}, events: {},
                note: 'Tabela chatbot_events não encontrada. Rode a migration 002.',
            });
        }
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/chatbot/analytics/funnel ────────────────────────────────
// Funil detalhado: conversas que entraram/saíram de cada estágio.
router.get('/chatbot/analytics/funnel', async (req, res) => {
    try {
        const days = parseInt(req.query.days || '30');
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const { data: events } = await supabase
            .from('chatbot_events')
            .select('event_type, conversation_id, metadata, created_at')
            .gte('created_at', since)
            .order('created_at', { ascending: true });

        if (!events || events.length === 0) {
            return res.json({ funnel: [], drop_offs: {} });
        }

        // Funnel stages in order
        const stages = [
            { key: 'welcome_sent',       label: 'Boas-vindas' },
            { key: 'intent_classified',  label: 'Intenção classificada' },
            { key: 'company_collected',  label: 'Empresa coletada' },
            { key: 'domain_collected',   label: 'Domínio coletado' },
            { key: 'context_collected',  label: 'Contexto coletado' },
            { key: 'classified',         label: 'Classificado (handoff)' },
        ];

        const funnel = stages.map(stage => ({
            ...stage,
            count: events.filter(e => e.event_type === stage.key).length,
        }));

        // Drop-offs: diferença entre estágios consecutivos
        const dropOffs = {};
        for (let i = 0; i < funnel.length - 1; i++) {
            const current = funnel[i].count;
            const next = funnel[i + 1].count;
            if (current > 0) {
                dropOffs[funnel[i].label] = {
                    entered: current,
                    exited: next,
                    dropped: current - next,
                    rate: Math.round((current - next) / current * 100),
                };
            }
        }

        res.json({ funnel, drop_offs: dropOffs });
    } catch (err) {
        if (err.message?.includes('does not exist')) {
            return res.json({ funnel: [], drop_offs: {}, note: 'Migration 002 required' });
        }
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/chatbot/faq ─────────────────────────────────────────────
// Lista todas as FAQs (built-in + custom).
router.get('/chatbot/faq', async (req, res) => {
    try {
        const customFaqs = await getSettingValue('chatbot_custom_faqs', []);
        res.json({
            builtin: BUILTIN_FAQS.map(f => ({
                id: f.id,
                triggers: f.triggers.slice(0, 5), // primeiros 5 triggers
                answer: f.answer.substring(0, 200) + '...',
                autoClassify: f.autoClassify || null,
                followUp: f.followUp || null,
            })),
            custom: customFaqs,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/chatbot/faq ────────────────────────────────────────────
// Adiciona ou atualiza FAQ custom.
router.post('/chatbot/faq', requireRole('Admin'), async (req, res) => {
    try {
        const { id, triggers, answer, autoClassify } = req.body;
        if (!triggers || !answer) {
            return res.status(400).json({ error: 'triggers (array) e answer (string) são obrigatórios' });
        }
        if (!Array.isArray(triggers) || triggers.length === 0) {
            return res.status(400).json({ error: 'triggers deve ser um array não vazio' });
        }

        const customFaqs = await getSettingValue('chatbot_custom_faqs', []);
        const faqId = id || `custom_${Date.now()}`;

        const existing = customFaqs.findIndex(f => f.id === faqId);
        const faqEntry = { id: faqId, triggers, answer, autoClassify: autoClassify || null };

        if (existing >= 0) {
            customFaqs[existing] = faqEntry;
        } else {
            customFaqs.push(faqEntry);
        }

        await saveSetting('chatbot_custom_faqs', customFaqs);
        res.json({ success: true, faq: faqEntry, total: customFaqs.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /api/chatbot/faq/:id ──────────────────────────────────────
router.delete('/chatbot/faq/:id', requireRole('Admin'), async (req, res) => {
    try {
        const customFaqs = await getSettingValue('chatbot_custom_faqs', []);
        const filtered = customFaqs.filter(f => f.id !== req.params.id);
        if (filtered.length === customFaqs.length) {
            return res.status(404).json({ error: 'FAQ não encontrada' });
        }
        await saveSetting('chatbot_custom_faqs', filtered);
        res.json({ success: true, remaining: filtered.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/chatbot/config ──────────────────────────────────────────
// Retorna configuração completa do bot.
router.get('/chatbot/config', async (req, res) => {
    try {
        const config = {};
        const keys = Object.keys(WORKER_DEFAULTS);
        for (const key of keys) {
            config[key] = await getSettingValue(key, WORKER_DEFAULTS[key]);
        }
        // Configurações extras
        config.outside_hours_message = await getSettingValue('outside_hours_message', null);
        config.business_hours_start  = await getSettingValue('business_hours_start', 9);
        config.business_hours_end    = await getSettingValue('business_hours_end', 18);
        config.max_retries           = await getSettingValue('chatbot_max_retries', 3);

        res.json({ config, defaults: WORKER_DEFAULTS });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/chatbot/config ─────────────────────────────────────────
// Atualiza configuração do bot.
router.post('/chatbot/config', requireRole('Admin'), async (req, res) => {
    try {
        const allowed = [
            'away_message', 'away_minutes', 'away_enabled',
            'nudge_enabled', 'nudge_minutes', 'nudge_message',
            'followup_enabled', 'followup_minutes',
            'outside_hours_message',
            'business_hours_start', 'business_hours_end',
            'chatbot_max_retries',
        ];

        const updated = {};
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                await saveSetting(key, req.body[key]);
                updated[key] = req.body[key];
            }
        }

        if (Object.keys(updated).length === 0) {
            return res.status(400).json({ error: 'Nenhum campo válido fornecido' });
        }

        res.json({ success: true, updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
