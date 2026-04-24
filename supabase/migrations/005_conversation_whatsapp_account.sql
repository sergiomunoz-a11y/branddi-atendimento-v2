-- Migration 005: link conversations to the WhatsApp account (Unipile account_id)
-- that received/started them. Enables filtering the inbox so each user sees
-- only conversations from the numbers they own or have been granted access to
-- via platform_users.permissions.whatsapp_accounts.

ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS whatsapp_account_id text;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_account
    ON conversations(whatsapp_account_id)
    WHERE whatsapp_account_id IS NOT NULL;
