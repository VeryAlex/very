-- Very Delivery CRM V2
-- Private chat notes and shared quick replies

-- ==========================================
-- ПРИВАТНЫЕ ЗАМЕТКИ КЛИЕНТОВ
-- ==========================================

CREATE TABLE IF NOT EXISTS chat_notes (
    chat_id text PRIMARY KEY
        REFERENCES chats(chat_id)
        ON DELETE CASCADE,

    note text NOT NULL DEFAULT '',

    updated_by text
        REFERENCES crm_users(email)
        ON DELETE SET NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_notes_updated_idx
ON chat_notes(updated_at DESC);


-- ==========================================
-- ОБЩИЕ БЫСТРЫЕ ОТВЕТЫ
-- ==========================================

CREATE TABLE IF NOT EXISTS quick_replies (
    id bigserial PRIMARY KEY,

    title text NOT NULL,
    content text NOT NULL,

    created_by text
        REFERENCES crm_users(email)
        ON DELETE SET NULL,

    updated_by text
        REFERENCES crm_users(email)
        ON DELETE SET NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT quick_replies_title_length
        CHECK (length(trim(title)) BETWEEN 1 AND 100),

    CONSTRAINT quick_replies_content_length
        CHECK (length(trim(content)) BETWEEN 1 AND 1000)
);

CREATE INDEX IF NOT EXISTS quick_replies_updated_idx
ON quick_replies(updated_at DESC, id);


-- ==========================================
-- ЗАВЕРШЕНИЕ
-- ==========================================

