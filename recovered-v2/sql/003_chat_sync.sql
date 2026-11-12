
-- Very Delivery CRM V2
-- Состояние синхронизации чатов Авито

CREATE TABLE IF NOT EXISTS chat_sync_state (
  sync_key text PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Состояние импорта каждого отдельного чата
CREATE TABLE IF NOT EXISTS chat_sync_progress (
  chat_id text PRIMARY KEY
    REFERENCES chats(chat_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  messages_imported integer NOT NULL DEFAULT 0,
  last_message_offset integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_sync_progress_status_idx
ON chat_sync_progress(status, updated_at);
