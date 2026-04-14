-- ============================================================
-- Branddi Atendimento v2 — Migration 002: Chatbot Analytics
-- Tabela de eventos para tracking de funnel e performance do bot
-- ============================================================

-- ─── CHATBOT EVENTS ──────────────────────────────────────────
-- Tracking de todos os eventos do bot para analytics.
-- Append-only: nunca deletar, usar para dashboards e funil.
CREATE TABLE IF NOT EXISTS chatbot_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    event_type      text NOT NULL,
    -- Tipos de evento:
    --   welcome_sent, welcome_triggered
    --   intent_classified, qualifying_retry
    --   company_collected, domain_collected, context_collected
    --   classified, escalated
    --   faq_answered
    --   nudge_sent, followup_sent, away_message_sent
    --   media_received, error
    metadata        jsonb DEFAULT '{}',
    created_at      timestamptz DEFAULT now()
);

-- Indices para queries de analytics
CREATE INDEX IF NOT EXISTS idx_chatbot_events_type
    ON chatbot_events(event_type);
CREATE INDEX IF NOT EXISTS idx_chatbot_events_created
    ON chatbot_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chatbot_events_conv
    ON chatbot_events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_events_type_created
    ON chatbot_events(event_type, created_at DESC);
