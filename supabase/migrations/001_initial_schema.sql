-- ============================================================
-- Branddi Atendimento v2 — Schema Inicial
-- Supabase Migration 001
-- ============================================================

-- ─── Extensoes ────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── LEADS ────────────────────────────────────────────────────
-- Contato central. Source of truth para todos os canais.
CREATE TABLE IF NOT EXISTS leads (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text,
    phone           text,               -- normalizado: so digitos, sem codigo pais
    email           text,
    company_name    text,
    origin          text NOT NULL DEFAULT 'whatsapp_direct',
                                        -- 'form' | 'whatsapp_direct' | 'prospecting'
    origin_metadata jsonb DEFAULT '{}', -- UTMs, page_url, form_data, etc.
    classification  text DEFAULT 'unclassified',
                                        -- 'comercial' | 'opec' | 'unclassified'
    -- CRM (agnostico — suporta Pipedrive, HubSpot, etc.)
    crm_type        text DEFAULT 'pipedrive',
    crm_person_id   text,
    crm_org_id      text,
    crm_deal_id     text,
    last_synced_at  timestamptz,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);

-- ─── CONVERSATIONS ────────────────────────────────────────────
-- Thread de WhatsApp. Um lead pode ter multiplas conversas.
CREATE TABLE IF NOT EXISTS conversations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id             uuid REFERENCES leads(id) ON DELETE SET NULL,
    whatsapp_chat_id    text UNIQUE,    -- ID do chat no Unipile
    channel             text DEFAULT 'whatsapp_direct',
                                        -- 'form' | 'whatsapp_direct'
    status              text DEFAULT 'waiting',
                                        -- 'waiting' | 'in_progress' | 'routed' | 'closed'
    assigned_to         text,           -- 'comercial' | 'opec' | 'prospecting'
    assigned_user_id    text,           -- platform_user.id (atribuicao individual)
    type                text DEFAULT 'inbound',  -- 'inbound' | 'prospecting'
    bot_away_sent       boolean DEFAULT false,
    chatbot_stage       text DEFAULT 'welcome',
                                        -- 'welcome' | 'qualifying' | 'classified' | 'human'
    chatbot_answers     jsonb DEFAULT '{}',
    crm_deal_id         text,
    crm_activity_id     text,
    last_message_at     timestamptz,
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now()
);

-- ─── MESSAGES ─────────────────────────────────────────────────
-- Cada mensagem de uma conversa.
CREATE TABLE IF NOT EXISTS messages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     uuid REFERENCES conversations(id) ON DELETE CASCADE,
    direction           text NOT NULL,  -- 'inbound' | 'outbound'
    sender_type         text NOT NULL,  -- 'lead' | 'bot' | 'human'
    sender_name         text,
    content             text,
    attachments         jsonb DEFAULT '[]',
    unipile_message_id  text UNIQUE,
    read_at             timestamptz,
    created_at          timestamptz DEFAULT now()
);

-- ─── ROUTING EVENTS ───────────────────────────────────────────
-- Historico de roteamento de cada conversa.
CREATE TABLE IF NOT EXISTS routing_events (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id     uuid REFERENCES conversations(id) ON DELETE CASCADE,
    from_team           text,           -- null | 'comercial' | 'opec'
    to_team             text NOT NULL,  -- 'comercial' | 'opec' | 'prospecting'
    reason              text,
    routed_by           text DEFAULT 'human',  -- 'bot' | 'human'
    routed_at           timestamptz DEFAULT now()
);

-- ─── CRM SYNC LOG ─────────────────────────────────────────────
-- Registro de toda sincronizacao com CRM externo.
-- Permite auditoria e retry de erros.
CREATE TABLE IF NOT EXISTS crm_sync_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type     text NOT NULL,      -- 'lead' | 'conversation' | 'message'
    entity_id       uuid NOT NULL,
    crm_type        text DEFAULT 'pipedrive',
    crm_object_type text,               -- 'person' | 'organization' | 'deal' | 'activity' | 'note'
    crm_object_id   text,
    sync_status     text DEFAULT 'pending',  -- 'pending' | 'success' | 'error'
    sync_payload    jsonb,
    error_message   text,
    retry_count     int DEFAULT 0,
    next_retry_at   timestamptz,
    synced_at       timestamptz DEFAULT now()
);

-- ─── SCRIPTS ──────────────────────────────────────────────────
-- Templates de mensagem para o atendente.
CREATE TABLE IF NOT EXISTS scripts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category    text NOT NULL,  -- 'welcome' | 'qualification' | 'comercial' | 'opec' | 'closing'
    title       text NOT NULL,
    content     text NOT NULL,  -- suporta {{nome}}, {{empresa}}, {{data}}
    is_active   boolean DEFAULT true,
    sort_order  int DEFAULT 0,
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now()
);

-- ─── PLATFORM USERS ──────────────────────────────────────────
-- Usuarios da plataforma de atendimento.
CREATE TABLE IF NOT EXISTS platform_users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           text UNIQUE NOT NULL,
    name            text NOT NULL,
    password_hash   text NOT NULL,
    role            text NOT NULL DEFAULT 'SDR',  -- 'Admin' | 'SDR' | 'Closer'
    active          boolean DEFAULT true,
    pipedrive_user_id text,
    avatar_url      text,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);

-- ─── PLATFORM SETTINGS ───────────────────────────────────────
-- Configuracoes da plataforma (substitui arquivo JSON).
CREATE TABLE IF NOT EXISTS platform_settings (
    key         text PRIMARY KEY,
    value       jsonb,
    updated_at  timestamptz DEFAULT now()
);

-- ─── INDICES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_classification ON leads(classification);
CREATE INDEX IF NOT EXISTS idx_leads_origin ON leads(origin);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_lead_id ON conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_chat_id ON conversations(whatsapp_chat_id);
CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type);
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_user ON conversations(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conv_direction ON messages(conversation_id, direction);
CREATE INDEX IF NOT EXISTS idx_crm_sync_log_status ON crm_sync_log(sync_status);
CREATE INDEX IF NOT EXISTS idx_crm_sync_log_entity ON crm_sync_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_crm_sync_retry ON crm_sync_log(sync_status, next_retry_at);

-- ─── SCRIPTS INICIAIS ─────────────────────────────────────────
INSERT INTO scripts (category, title, content, sort_order) VALUES
    ('welcome', 'Boas-vindas Comercial',
     'Ola, {{nome}}! Sou do time da Branddi. Que bom ter voce aqui! Como posso te ajudar hoje?',
     1),
    ('welcome', 'Boas-vindas OPEC',
     'Ola, {{nome}}! Recebemos sua mensagem sobre a notificacao de brand bidding. Vou te conectar com nosso time de operacoes. Um momento!',
     2),
    ('comercial', 'Apresentacao BB',
     'A Branddi protege sua marca contra anunciantes que usam seu nome no Google Ads. Quer ver um diagnostico gratuito de como sua marca esta sendo usada?',
     3),
    ('comercial', 'Agendar Reuniao',
     'Que tal agendarmos uma conversa de 30 minutos para eu mostrar como a Branddi pode proteger a {{empresa}}? Qual horario funciona melhor para voce?',
     4),
    ('opec', 'Confirmacao Negativacao',
     'Obrigado por confirmar, {{nome}}! Vou registrar a negativacao dos termos e nosso time de operacoes vai verificar em ate 48h.',
     5),
    ('opec', 'Pedido de Remocao',
     'Entendido, {{nome}}! Para processar a remocao dos termos da {{empresa}}, preciso que voce confirme quais palavras-chave devem ser negativadas. Pode me enviar a lista?',
     6),
    ('closing', 'Encerramento',
     'Foi um prazer conversar com voce, {{nome}}! Se precisar de qualquer coisa, estamos aqui. Tenha um otimo dia!',
     7)
ON CONFLICT DO NOTHING;
