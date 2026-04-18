/**
 * Scripts Routes — Templates de mensagem
 * v2: Validação com enum de categorias e maxLength
 * v3: Suporte a scripts pessoais (is_public + owner_user_id)
 */
import { Router } from 'express';
import { upsertScript } from '../services/supabase.js';
import supabase from '../services/supabase.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const VALID_CATEGORIES = ['welcome', 'qualification', 'comercial', 'opec', 'closing'];

// ─── GET /api/scripts — Lista scripts (públicos + pessoais do user) ──
router.get('/scripts', requireAuth, async (req, res) => {
    try {
        const { category } = req.query;
        const userId = req.user?.id;
        const isAdmin = req.user?.role === 'Admin';

        // Admin vê tudo; demais veem públicos + próprios
        let query = supabase
            .from('scripts')
            .select('*')
            .eq('is_active', true)
            .order('sort_order', { ascending: true });

        if (category) query = query.eq('category', category);

        if (!isAdmin) {
            // Públicos OU do próprio usuário
            query = query.or(`is_public.eq.true,owner_user_id.eq.${userId}`);
        }

        const { data, error } = await query;
        if (error) throw error;
        res.json({ scripts: data || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── POST /api/scripts — Cria script ─────────────────────────────────
router.post('/scripts', requireAuth, async (req, res) => {
    try {
        const err = validate(req.body, {
            category: { required: true, type: 'string', enum: VALID_CATEGORIES },
            title:    { required: true, type: 'string', maxLength: 200 },
            content:  { required: true, type: 'string', maxLength: 5000 },
        });
        if (err) return res.status(400).json({ error: err });

        const { category, title, content, sort_order = 0 } = req.body;
        const is_public = req.body.is_public !== false; // default true
        const owner_user_id = req.user.id;

        const script = await upsertScript({ category, title, content, sort_order, is_public, owner_user_id });
        res.json({ success: true, script });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── PUT /api/scripts/:id — Atualiza script ───────────────────────────
router.put('/scripts/:id', requireAuth, async (req, res) => {
    try {
        const { title, content, category, is_active, sort_order, is_public } = req.body;

        // Valida campos se fornecidos
        const rules = {};
        if (category !== undefined) rules.category = { type: 'string', enum: VALID_CATEGORIES };
        if (title !== undefined)    rules.title    = { type: 'string', maxLength: 200 };
        if (content !== undefined)  rules.content  = { type: 'string', maxLength: 5000 };

        if (Object.keys(rules).length > 0) {
            const err = validate(req.body, rules);
            if (err) return res.status(400).json({ error: err });
        }

        // Verifica permissão: só dono ou Admin pode editar
        const { data: existing } = await supabase
            .from('scripts')
            .select('owner_user_id')
            .eq('id', req.params.id)
            .single();

        if (existing?.owner_user_id && existing.owner_user_id !== req.user.id && req.user.role !== 'Admin') {
            return res.status(403).json({ error: 'Sem permissão para editar este script' });
        }

        const updates = { title, content, category, is_active, sort_order, updated_at: new Date().toISOString() };
        if (is_public !== undefined) updates.is_public = is_public;

        const { data, error } = await supabase
            .from('scripts')
            .update(updates)
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
router.delete('/scripts/:id', requireAuth, async (req, res) => {
    try {
        // Verifica permissão: só dono ou Admin pode deletar
        const { data: existing } = await supabase
            .from('scripts')
            .select('owner_user_id')
            .eq('id', req.params.id)
            .single();

        if (existing?.owner_user_id && existing.owner_user_id !== req.user.id && req.user.role !== 'Admin') {
            return res.status(403).json({ error: 'Sem permissão para remover este script' });
        }

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
