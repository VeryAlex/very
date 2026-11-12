
CREATE TABLE users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'manager')),
    password_hash TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chats (
    id BIGSERIAL PRIMARY KEY,
    avito_chat_id TEXT NOT NULL UNIQUE,
    peer_id TEXT,
    peer_name TEXT NOT NULL DEFAULT '',
    item_id TEXT,
    item_title TEXT NOT NULL DEFAULT '',
    item_url TEXT,
    item_image_url TEXT,
    last_message_id TEXT,
    last_message_at TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ,
    raw JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chats_last_message_idx
ON chats (last_message_at DESC);

CREATE INDEX chats_peer_id_idx
ON chats (peer_id);

CREATE TABLE chat_participants (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    avito_user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    profile_url TEXT,
    avatar_url TEXT,
    is_own_account BOOLEAN NOT NULL DEFAULT FALSE,
    raw JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (chat_id, avito_user_id)
);

CREATE TABLE messages (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    avito_message_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    body TEXT NOT NULL DEFAULT '',
    message_type TEXT NOT NULL DEFAULT 'text',
    author_id TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    raw JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (chat_id, avito_message_id)
);

CREATE INDEX messages_chat_date_idx
ON messages (chat_id, created_at);

CREATE TABLE chat_assignments (
    chat_id BIGINT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    manager_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'assigned',
    order_id TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_assignments_manager_idx
ON chat_assignments (manager_id);

CREATE TABLE chat_notes (
    id BIGSERIAL PRIMARY KEY,
    chat_id BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id),
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
    id BIGSERIAL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_sessions_expiry_idx
ON auth_sessions (expires_at);

CREATE TABLE avito_sync_state (
    sync_key TEXT PRIMARY KEY,
    cursor TEXT,
    last_success_at TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

