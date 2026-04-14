/**
 * Dashboard Routes — KPIs e métricas comerciais
 */
import { Router } from 'express';
import { getDashboardStats } from '../services/supabase.js';

const router = Router();

// ─── GET /api/dashboard — KPIs principais ────────────────────────────
router.get('/dashboard', async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const stats = await getDashboardStats({ days: parseInt(days) });
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
