BEGIN;

CREATE TABLE IF NOT EXISTS manager_chat_statuses (
    id BIGSERIAL PRIMARY KEY,
    manager_id BIGINT NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT manager_chat_status_name_length
        CHECK (char_length(trim(name)) BETWEEN 1 AND 60),
    CONSTRAINT manager_chat_status_unique
        UNIQUE (manager_id, name),
    CONSTRAINT manager_chat_status_owner_unique
        UNIQUE (id, manager_id)
);

CREATE INDEX IF NOT EXISTS manager_chat_statuses_manager_idx
    ON manager_chat_statuses (manager_id);

CREATE TABLE IF NOT EXISTS manager_chat_status_assignments (
    chat_id BIGINT NOT NULL
        REFERENCES chats(id) ON DELETE CASCADE,
    manager_id BIGINT NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,
    status_id BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, manager_id),
    CONSTRAINT manager_chat_status_assignment_owner
        FOREIGN KEY (status_id, manager_id)
        REFERENCES manager_chat_statuses(id, manager_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS manager_chat_status_assignments_manager_idx
    ON manager_chat_status_assignments (manager_id);

GRANT SELECT, INSERT, UPDATE, DELETE
    ON manager_chat_statuses,
       manager_chat_status_assignments
    TO vd_crm_app;

GRANT USAGE, SELECT
    ON SEQUENCE manager_chat_statuses_id_seq
    TO vd_crm_app;

COMMIT;
