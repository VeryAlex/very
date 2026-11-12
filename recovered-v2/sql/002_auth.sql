
-- Very Delivery CRM V2: authentication

-- Хеш пароля пользователя
ALTER TABLE crm_users
ADD COLUMN IF NOT EXISTS password_hash text;

-- Сессии авторизованных пользователей
CREATE TABLE IF NOT EXISTS auth_sessions (
    id bigserial PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    user_email text NOT NULL
        REFERENCES crm_users(email)
        ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_sessions_by_user
ON auth_sessions(user_email);

CREATE INDEX IF NOT EXISTS auth_sessions_by_expiry
ON auth_sessions(expires_at);
