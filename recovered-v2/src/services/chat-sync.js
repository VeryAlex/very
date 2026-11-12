
'use strict';

const {
  getChats,
  getMessages
} = require('./avito');

const { pool } = require('../db');

const SELF_ID = String(process.env.AVITO_USER_ID || '');
const SYNC_KEY = 'initial_90_days';
const PAGE_SIZE = 100;
const DEFAULT_DAYS = 90;

function toDate(timestamp) {
  if (!timestamp) return null;
  const date = new Date(Number(timestamp) * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getPeer(chat) {
  const users = chat.users || [];

  return users.find(
    user => String(user.id) !== SELF_ID
  ) || users[0] || {};
}

function getMessageText(message) {
  const content = message.content || {};

  if (typeof content.text === 'string') {
    return content.text;
  }

  if (typeof content.link === 'string') {
    return content.link;
  }

  return null;
}

async function saveChat(chat) {
  const peer = getPeer(chat);
  const context = chat.context?.value || {};
  const lastMessage = chat.last_message || {};

  await pool.query(
    `INSERT INTO chats (
       chat_id,
       peer_id,
       peer_name,
       item_title,
       item_url,
       last_message_id,
       last_message_at,
       last_synced_at,
       raw
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8::jsonb)
     ON CONFLICT (chat_id)
     DO UPDATE SET
       peer_id = COALESCE(EXCLUDED.peer_id, chats.peer_id),
       peer_name = COALESCE(EXCLUDED.peer_name, chats.peer_name),
       item_title = COALESCE(EXCLUDED.item_title, chats.item_title),
       item_url = COALESCE(EXCLUDED.item_url, chats.item_url),
       last_message_id = CASE
         WHEN EXCLUDED.last_message_at >=
              COALESCE(chats.last_message_at, '-infinity')
         THEN EXCLUDED.last_message_id
         ELSE chats.last_message_id
       END,
       last_message_at = GREATEST(
         chats.last_message_at,
         EXCLUDED.last_message_at
       ),
       last_synced_at = now(),
       raw = EXCLUDED.raw`,
    [
      chat.id,
      peer.id ? String(peer.id) : null,
      peer.name || null,
      context.title || null,
      context.url || null,
      lastMessage.id || null,
      toDate(lastMessage.created || chat.updated),
      JSON.stringify(chat)
    ]
  );

  await pool.query(
    `INSERT INTO chat_sync_progress (chat_id, status)
     VALUES ($1, 'pending')
     ON CONFLICT (chat_id) DO NOTHING`,
    [chat.id]
  );
}

async function saveMessages(chatId, messages) {
  if (!messages.length) return;

  const rows = messages.map(message => ({
    message_id: String(message.id),
    author_id: message.author_id
      ? String(message.author_id)
      : null,
    direction: message.direction || null,
    message_type: message.type || null,
    text_content: getMessageText(message),
    created_at: toDate(message.created),
    raw: message
  }));

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO messages (
         chat_id,
         message_id,
         author_id,
         direction,
         message_type,
         text_content,
         created_at,
         raw
       )
       SELECT
         $1,
         x.message_id,
         x.author_id,
         x.direction,
         x.message_type,
         x.text_content,
         x.created_at,
         x.raw
       FROM jsonb_to_recordset($2::jsonb) AS x(
         message_id text,
         author_id text,
         direction text,
         message_type text,
         text_content text,
         created_at timestamptz,
         raw jsonb
       )
       ON CONFLICT (chat_id, message_id) DO NOTHING`,
      [chatId, JSON.stringify(rows)]
    );

    await client.query(
      `UPDATE chat_sync_progress
       SET messages_imported = (
         SELECT COUNT(*)
         FROM messages
         WHERE chat_id = $1
       ),
       updated_at = now()
       WHERE chat_id = $1`,
      [chatId]
    );

    await client.query('COMMIT');

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;

  } finally {
    client.release();
  }
}

async function syncChatHistory(chatId) {
  await pool.query(
    `UPDATE chat_sync_progress
     SET status = 'running',
         started_at = COALESCE(started_at, now()),
         last_error = NULL,
         updated_at = now()
     WHERE chat_id = $1`,
    [chatId]
  );

  const progress = await pool.query(
    `SELECT last_message_offset
     FROM chat_sync_progress
     WHERE chat_id = $1`,
    [chatId]
  );

  let offset = Number(
    progress.rows[0]?.last_message_offset || 0
  );

  let imported = 0;

  try {
    while (true) {
      const result = await getMessages(chatId, {
        limit: PAGE_SIZE,
        offset
      });

      const messages = result.messages || [];

      if (messages.length) {
        await saveMessages(chatId, messages);
        imported += messages.length;
      }

      offset += messages.length;

      await pool.query(
        `UPDATE chat_sync_progress
         SET last_message_offset = $2,
             updated_at = now()
         WHERE chat_id = $1`,
        [chatId, offset]
      );

      if (
        !result.meta?.has_more ||
        messages.length === 0
      ) {
        break;
      }
    }

    await pool.query(
      `UPDATE chat_sync_progress
       SET status = 'completed',
           finished_at = now(),
           last_error = NULL,
           updated_at = now()
       WHERE chat_id = $1`,
      [chatId]
    );

    return imported;

  } catch (error) {
    await pool.query(
      `UPDATE chat_sync_progress
       SET status = 'failed',
           last_error = $2,
           updated_at = now()
       WHERE chat_id = $1`,
      [chatId, error.message]
    );

    throw error;
  }
}

async function collectChats(days, maxChats) {
  const cutoff = Math.floor(
    Date.now() / 1000 - days * 86400
  );

  const selected = new Map();

  for (const type of ['u2i', 'u2u', 'a2u']) {
    for (let offset = 0; offset <= 1000; offset += PAGE_SIZE) {
      const data = await getChats({
        limit: PAGE_SIZE,
        offset,
        chatTypes: type
      });

      const chats = data.chats || [];

      if (!chats.length) break;

      let oldest = Infinity;

      for (const chat of chats) {
        const timestamp = Number(
          chat.last_message?.created || chat.updated || 0
        );

        if (timestamp) {
          oldest = Math.min(oldest, timestamp);
        }

        if (timestamp >= cutoff) {
          selected.set(chat.id, chat);
        }
      }

      if (maxChats && selected.size >= maxChats) {
        return [...selected.values()].slice(0, maxChats);
      }

      // API выдаёт чаты от новых к старым.
      if (oldest < cutoff) break;

      if (chats.length < PAGE_SIZE) break;
    }
  }

  return [...selected.values()];
}

async function syncChats(options = {}) {
  if (!SELF_ID) {
    throw new Error('AVITO_USER_ID is required');
  }

  const days = Number(options.days || DEFAULT_DAYS);
  const maxChats = options.maxChats
    ? Number(options.maxChats)
    : null;

  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error('Invalid days parameter');
  }

  if (
    maxChats !== null &&
    (!Number.isInteger(maxChats) || maxChats < 1)
  ) {
    throw new Error('Invalid maxChats parameter');
  }

  const lockClient = await pool.connect();

const lock = await lockClient.query(
  'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
  [SYNC_KEY]
);

if (!lock.rows[0].acquired) {
  lockClient.release();
  throw new Error('Chat synchronization is already running');
}

  if (!lock.rows[0].acquired) {
    throw new Error('Chat synchronization is already running');
  }

  let processed = 0;
  let imported = 0;
  let failed = 0;

  try {
    await pool.query(
      `INSERT INTO chat_sync_state (
         sync_key, status, started_at, finished_at,
         last_error, stats, updated_at
       )
       VALUES ($1, 'running', now(), NULL, NULL, '{}'::jsonb, now())
       ON CONFLICT (sync_key)
       DO UPDATE SET
         status = 'running',
         started_at = now(),
         finished_at = NULL,
         last_error = NULL,
         updated_at = now()`,
      [SYNC_KEY]
    );

    console.log('Collecting chats...');

    const chats = await collectChats(days, maxChats);

    console.log('Chats selected:', chats.length);

    for (const chat of chats) {
      try {
        await saveChat(chat);

        const result = await pool.query(
          `SELECT status
           FROM chat_sync_progress
           WHERE chat_id = $1`,
          [chat.id]
        );

        if (result.rows[0]?.status === 'completed') {
          processed++;
          continue;
        }

        const count = await syncChatHistory(chat.id);

        imported += count;
        processed++;

        console.log(
          'CHAT_OK:',
          chat.id,
          'messages:',
          count,
          'progress:',
          processed + '/' + chats.length
        );

      } catch (error) {
        failed++;

        console.error(
          'CHAT_FAILED:',
          chat.id,
          error.message
        );
      }
    }

    const complete = !maxChats && failed === 0;

    const stats = {
      chats_selected: chats.length,
      chats_processed: processed,
      chats_failed: failed,
      messages_imported: imported,
      days
    };

    await pool.query(
      `UPDATE chat_sync_state
       SET status = $2,
           finished_at = CASE WHEN $2 = 'completed'
             THEN now() ELSE NULL END,
           stats = $3::jsonb,
           last_error = $4,
           updated_at = now()
       WHERE sync_key = $1`,
      [
        SYNC_KEY,
        complete ? 'completed' : 'running',
        JSON.stringify(stats),
        failed ? `${failed} chats failed` : null
      ]
    );

    console.log('SYNC_RESULT:', stats);

    return stats;

  } catch (error) {
    await pool.query(
      `UPDATE chat_sync_state
       SET status = 'failed',
           last_error = $2,
           updated_at = now()
       WHERE sync_key = $1`,
      [SYNC_KEY, error.message]
    );

    throw error;

    } finally {
    try {
      await lockClient.query(
        'SELECT pg_advisory_unlock(hashtext($1))',
        [SYNC_KEY]
      );
    } finally {
      lockClient.release();
    }
  }
}

module.exports = {
  syncChats,
  syncChatHistory
};

