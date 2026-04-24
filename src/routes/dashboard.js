/**
 * Dashboard Routes — KPIs e métricas comerciais
 */
import { Router } from 'express';
import { getDashboardStats, getAnalyticsDashboard } from '../services/supabase.js';

const router = Router();

// ─── GET /api/dashboard — KPIs antigos (mantido p/ compat) ────────────
router.get('/dashboard', async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const stats = await getDashboardStats({ days: parseInt(days) });
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /api/dashboard/analytics — Dashboard novo (por SDR, por número) ─
// Admin vê tudo + pode filtrar. SDR vê apenas os próprios dados.
router.get('/dashboard/analytics', async (req, res) => {
    try {
        const { days = 30, user_id, account_id, type } = req.query;
        const data = await getAnalyticsDashboard({
            days: parseInt(days),
            user_id: user_id || null,
            account_id: account_id || null,
            type: type || null,
            role: req.user?.role || 'Usuario',
            requester_id: req.user?.id || null,
        });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
