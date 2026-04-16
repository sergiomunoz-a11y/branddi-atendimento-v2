-- ============================================================
-- Branddi Atendimento v2 — Migration 003
-- User Permissions: sent_by tracking + role unification
-- ============================================================

-- ─── Messages: rastreio de quem enviou ───────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by_user_id uuid REFERENCES platform_users(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by_name text;

-- Index para queries de métricas por usuário
CREATE INDEX IF NOT EXISTS idx_messages_sent_by ON messages(sent_by_user_id) WHERE sent_by_user_id IS NOT NULL;

-- ─── Platform Users: garantir colunas extras ─────────────────
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS permissions jsonb DEFAULT '{}';
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS pipedrive_api_token text;
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS google_id text;
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- ─── WhatsApp Accounts table (se não existe) ─────────────────
CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    unipile_account_id text UNIQUE NOT NULL,
    phone_number    text,
    label           text,
    status          text DEFAULT 'active',
    connected_by_user_id uuid REFERENCES platform_users(id),
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);

-- ─── Conversations: assigned_user_id para atribuição ─────────
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_user_id uuid REFERENCES platform_users(id);
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_user ON conversations(assigned_user_id) WHERE assigned_user_id IS NOT NULL;
