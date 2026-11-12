-- Initial schema only. No Avito webhook ingestion or authentication is enabled.
CREATE TABLE IF NOT EXISTS crm_users (
  email text PRIMARY KEY,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'manager')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chats (
  chat_id text PRIMARY KEY,
  avito_account_id text,
  peer_id text,
  peer_name text,
  item_title text,
  item_url text,
  last_message_id text,
  last_message_at timestamptz,
  last_synced_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_assignments (
  chat_id text PRIMARY KEY REFERENCES chats(chat_id) ON DELETE CASCADE,
  manager_email text REFERENCES crm_users(email) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'free',
  order_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  chat_id text NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
  message_id text NOT NULL,
  author_id text,
  direction text,
  message_type text,
  text_content text,
  created_at timestamptz,
  is_deleted boolean NOT NULL DEFAULT false,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS messages_by_chat_time ON messages(chat_id, created_at DESC, message_id);
CREATE INDEX IF NOT EXISTS chats_by_recent_message ON chats(last_message_at DESC NULLS LAST);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_key text PRIMARY KEY,
  event_type text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text
);
CREATE TABLE IF NOT EXISTS chat_read_state (
  chat_id text NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
  message_id text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chat_id, message_id)
);
-- Авторизация пользователей

ALTER TABLE crm_users
ADD COLUMN IF NOT EXISTS password_hash text;

-- Сессии пользователей
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY,
  user_email text NOT NULL
    REFERENCES crm_users(email)
    ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Индекс для проверки активных сессий
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
ON auth_sessions(user_email);

CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx
ON auth_sessions(expires_at);