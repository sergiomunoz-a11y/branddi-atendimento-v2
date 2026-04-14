/**
 * Scripts Routes — Templates de mensagem
 * v2: Adiciona validação com enum de categorias e maxLength
 */
import { Router } from 'express';
import { getScripts, upsertScript } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import { validate } from '../middleware/validate.js';

const router = Router();

const VALID_CATEGORIES = ['welcome', 'qualification', 'comercial', 'opec', 'closing'];

// ─── GET /api/scripts — Lista scripts ────────────────────────────────
router.get('/scripts', async (req, res) => {
    try {
        const { category } = req.query;
        const scripts = await getScripts({ category });
        res.json({ scripts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/scripts — Cria script ─────────────────────────────────
router.post('/scripts', async (req, res) => {
    try {
        const err = validate(req.body, {
            category: { required: true, type: 'string', enum: VALID_CATEGORIES },
            title:    { required: true, type: 'string', maxLength: 200 },
            content:  { required: true, type: 'string', maxLength: 5000 },
        });
        if (err) return res.status(400).json({ error: err });

        const { category, title, content, sort_order = 0 } = req.body;
        const script = await upsertScript({ category, title, content, sort_order });
        res.json({ success: true, script });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PUT /api/scripts/:id — Atualiza script ───────────────────────────
router.put('/scripts/:id', async (req, res) => {
    try {
        const { title, content, category, is_active, sort_order } = req.body;

        // Valida campos se fornecidos
        const rules = {};
        if (category !== undefined) rules.category = { type: 'string', enum: VALID_CATEGORIES };
        if (title !== undefined)    rules.title    = { type: 'string', maxLength: 200 };
        if (content !== undefined)  rules.content  = { type: 'string', maxLength: 5000 };

        if (Object.keys(rules).length > 0) {
            const err = validate(req.body, rules);
            if (err) return res.status(400).json({ error: err });
        }

        const { data, error } = await supabase
            .from('scripts')
            .update({ title, content, category, is_active, sort_order, updated_at: new Date().toISOString() })
            .eq('id', req.params.id)
            .select()
            .single();
        if (error) throw error;
        res.json({ success: true, script: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── DELETE /api/scripts/:id — Desativa script ───────────────────────
router.delete('/scripts/:id', async (req, res) => {
    try {
        const { error } = await supabase
            .from('scripts')
            .update({ is_active: false })
            .eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
