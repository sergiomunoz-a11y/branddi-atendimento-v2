-- ============================================================
-- Migration 004 — Arquivamento de conversas
-- Admin pode arquivar (reversível) ou deletar (permanente) conversas.
-- ============================================================

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_conversations_archived_at
    ON conversations(archived_at);
