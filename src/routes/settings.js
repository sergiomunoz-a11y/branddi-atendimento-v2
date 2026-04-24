/**
 * Settings Routes — Configurações da plataforma
 * v2: Usa Supabase platform_settings em vez de arquivo JSON local
 * Inclui: perfil do atendente, bot 24h, e configuração Pipedrive (funil/etapa/proprietário)
 */
import { Router } from 'express';
import { getSettings, saveSetting } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import { pdGet } from '../services/pipedrive.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

const DEFAULTS = {
    // Perfil
    agent_name:  'Branddi Atendimento',
    agent_photo: '',
    // Bot 24h
    away_message: 'Olá! 👋 No momento nossa equipe não está disponível, mas retornaremos assim que possível! ⏰\n\nEnquanto isso, fique à vontade para enviar mais informações sobre sua necessidade. 😊',
    away_minutes: 10,
    away_enabled: true,
    // Pipedrive — Funil Inbound SDR (IDs confirmados)
    pipedrive_pipeline_id:   5,
    pipedrive_pipeline_name: '3. Inbound SDR',
    pipedrive_stage_id:      208,
    pipedrive_stage_name:    'MQL - Novo Lead',
    pipedrive_owner_id:      null,
    pipedrive_owner_name:    'Não atribuído',
    // Chatbot mode
    bot_mode: 'ai', // 'ai' | 'manual' | 'off'
    // Apollo enrichment (consome créditos Apollo a cada chamada)
    apollo_enabled: false,
    // Auto-match de leads no Pipedrive via Apollo (consome 1 crédito por match novo)
    apollo_auto_match: false,
};

// ─── GET /api/settings/my-profile — Perfil pessoal do user logado ─────
router.get('/settings/my-profile', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('platform_users')
            .select('id, email, name, role, avatar_url, pipedrive_user_id')
            .eq('id', req.user.id)
            .single();
        if (error) return res.status(500).json({ error: error.message });
        res.json({ profile: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PATCH /api/settings/my-profile — Atualiza perfil pessoal ────────
router.patch('/settings/my-profile', requireAuth, async (req, res) => {
    try {
        const { name, avatar_url } = req.body;
        const updates = { updated_at: new Date().toISOString() };
        if (name !== undefined) updates.name = name;
        if (avatar_url !== undefined) updates.avatar_url = avatar_url;

        const { data, error } = await supabase
            .from('platform_users')
            .update(updates)
            .eq('id', req.user.id)
            .select('id, email, name, role, avatar_url')
            .single();
        if (error) return res.status(500).json({ error: error.message });
        res.json({ profile: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/settings — Configurações globais (Admin/SDR autorizado) ─
router.get('/settings', async (req, res) => {
    try {
        const dbSettings = await getSettings();
        const merged = { ...DEFAULTS };
        for (const [k, v] of Object.entries(dbSettings)) {
            merged[k] = v;
        }
        res.json({ settings: merged });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/settings — Só Admin pode alterar configs globais ───────
router.post('/settings', requireAuth, requireRole('Admin'), async (req, res) => {
    try {
        const allowed = [
            'agent_name', 'agent_photo',
            'away_message', 'away_minutes', 'away_enabled',
            'pipedrive_pipeline_id', 'pipedrive_pipeline_name',
            'pipedrive_stage_id', 'pipedrive_stage_name',
            'pipedrive_owner_id', 'pipedrive_owner_name',
            'bot_mode',
            'apollo_enabled',
            'apollo_auto_match',
        ];
        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                await saveSetting(key, req.body[key]);
            }
        }
        const settings = await getSettings();
        res.json({
            success: true,
            settings: {
                ...DEFAULTS,
                ...settings,
                agent_photo: settings.agent_photo ? '(foto salva)' : '',
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/settings/pipedrive-data — Carrega funis, etapas e usuários ─
router.get('/settings/pipedrive-data', async (req, res) => {
    try {
        const [pipelinesRes, usersRes] = await Promise.all([
            pdGet('/pipelines'),
            pdGet('/users?limit=500'),
        ]);

        const pipelines = (pipelinesRes.data || [])
            .filter(p => !p.is_deleted)
            .map(p => ({ id: p.id, name: p.name }));

        const users = (usersRes.data || [])
            .filter(u => u.active_flag && !u.is_deleted)
            .map(u => ({ id: u.id, name: u.name, email: u.email }))
            .sort((a, b) => a.name.localeCompare(b.name));

        // Busca etapas do pipeline salvo nas configurações
        const dbSettings = await getSettings();
        const pipelineId = req.query.pipeline_id || dbSettings.pipedrive_pipeline_id || DEFAULTS.pipedrive_pipeline_id;
        const stagesRes = await pdGet(`/stages?pipeline_id=${pipelineId}`);
        const stages = (stagesRes.data || [])
            .filter(s => !s.is_deleted)
            .sort((a, b) => a.order_nr - b.order_nr)
            .map(s => ({ id: s.id, name: s.name, order_nr: s.order_nr }));

        res.json({ pipelines, stages, users });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/settings/stages?pipeline_id=X — Etapas de um funil ─────
router.get('/settings/stages', async (req, res) => {
    try {
        const { pipeline_id } = req.query;
        if (!pipeline_id) return res.status(400).json({ error: 'pipeline_id obrigatório' });
        const stagesRes = await pdGet(`/stages?pipeline_id=${pipeline_id}`);
        const stages = (stagesRes.data || [])
            .filter(s => !s.is_deleted)
            .sort((a, b) => a.order_nr - b.order_nr)
            .map(s => ({ id: s.id, name: s.name }));
        res.json({ stages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

// ─── Helper exportado — async (usa DB em vez de arquivo) ─────────────
export async function getSettingValue(key, defaultValue = null) {
    try {
        const settings = await getSettings();
        return settings[key] ?? DEFAULTS[key] ?? defaultValue;
    } catch {
        return defaultValue;
    }
}
