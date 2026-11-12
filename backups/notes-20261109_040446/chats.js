'use strict';

const { getUser } = require('../auth');
const { getAccount, avitoRequest } = require('../services/avito');
const { publish } = require('../services/realtime');

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = '';

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 20000) {
      throw new Error('Слишком большой запрос');
    }
  }

  return JSON.parse(body || '{}');
}

async function allowedChat(db, user, chatId) {
  const result = await db.query(`
    SELECT c.id, c.avito_chat_id
    FROM chats c
    LEFT JOIN chat_assignments ca ON ca.chat_id = c.id
    WHERE c.id = $1
      AND (
        $2 = 'admin'
        OR ca.manager_id IS NULL
        OR ca.manager_id = $3
      )
  `, [chatId, user.role, user.id]);

  return result.rows[0] || null;
}

async function handleChats(req, res, db, url) {
  const route = url.pathname;

  if (!route.startsWith('/api/chats')) return false;

  const user = await getUser(req, db);

  if (!user) {
    return send(res, 401, { error: 'Необходим вход' });
  }

  try {

    // СПИСОК ЧАТОВ
    if (route === '/api/chats' && req.method === 'GET') {
      const result = await db.query(`
        SELECT
          c.id,
          c.avito_chat_id,
          c.peer_id,
          c.peer_name,
          c.item_title,
          c.item_url,
          c.item_image_url,
          c.item_price,
          c.last_message_id,
          c.last_message_at,
          ca.manager_id,
          (
            SELECT COUNT(*)::int
            FROM messages um
            WHERE um.chat_id = c.id
              AND um.direction = 'in'
              AND um.created_at > COALESCE(
                (
                  SELECT MAX(cr.last_read_at)
                  FROM chat_reads cr
                  WHERE cr.chat_id = c.id
                ),
                '-infinity'::timestamptz
              )
          ) AS unread_count,
          u.display_name AS manager_name,
          m.body AS last_message,
          m.direction AS last_direction
        FROM chats c
        LEFT JOIN chat_assignments ca ON ca.chat_id = c.id
        LEFT JOIN users u ON u.id = ca.manager_id
        LEFT JOIN LATERAL (
          SELECT body, direction
          FROM messages
          WHERE chat_id = c.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) m ON true
        WHERE
          $1 = 'admin'
          OR ca.manager_id IS NULL
          OR ca.manager_id = $2
        ORDER BY c.last_message_at DESC NULLS LAST
        LIMIT 1000
      `, [user.role, user.id]);

      return send(res, 200, {
        chats: result.rows
      });
    }

    // НАЗНАЧЕНИЕ МЕНЕДЖЕРА
    const assignMatch = route.match(
      /^\/api\/chats\/(\d+)\/assign$/
    );

    if (assignMatch && req.method === 'POST') {
      if (user.role !== 'admin') {
        return send(res, 403, {
          error: 'Недостаточно прав'
        });
      }

      const chatId = Number(assignMatch[1]);
      const body = await readBody(req);

      const managerId =
        body.manager_id == null || body.manager_id === ''
          ? null
          : Number(body.manager_id);

      if (managerId !== null) {
        const manager = await db.query(`
          SELECT id
          FROM users
          WHERE id = $1
            AND role = 'manager'
            AND is_active = TRUE
        `, [managerId]);

        if (!manager.rowCount) {
          return send(res, 404, {
            error: 'Менеджер не найден'
          });
        }
      }

      const chat = await db.query(
        'SELECT id FROM chats WHERE id = $1',
        [chatId]
      );

      if (!chat.rowCount) {
        return send(res, 404, {
          error: 'Чат не найден'
        });
      }

      if (managerId === null) {
        await db.query(
          'DELETE FROM chat_assignments WHERE chat_id = $1',
          [chatId]
        );
      } else {
        await db.query(`
          INSERT INTO chat_assignments
            (chat_id, manager_id, status, updated_at)
          VALUES ($1, $2, 'assigned', now())
          ON CONFLICT (chat_id)
          DO UPDATE SET
            manager_id = EXCLUDED.manager_id,
            status = 'assigned',
            updated_at = now()
        `, [chatId, managerId]);
      }

      publish('assignment', {
        chat_id: String(chatId),
        manager_id: managerId
      });

      return send(res, 200, {
        success: true,
        manager_id: managerId
      });
    }

    // ИСТОРИЯ СООБЩЕНИЙ
    const messagesMatch = route.match(
      /^\/api\/chats\/(\d+)\/messages$/
    );

    if (messagesMatch && req.method === 'GET') {
      const chatId = Number(messagesMatch[1]);

      const chat = await allowedChat(db, user, chatId);

      if (!chat) {
        return send(res, 404, {
          error: 'Чат не найден'
        });
      }

      await db.query(`
        INSERT INTO chat_reads (chat_id, user_id, last_read_at)
        SELECT
          $1,
          $2,
          MAX(created_at)
        FROM messages
        WHERE chat_id = $1
          AND direction = 'in'
        HAVING COUNT(*) > 0
        ON CONFLICT (chat_id, user_id)
        DO UPDATE SET
          last_read_at = GREATEST(
            chat_reads.last_read_at,
            EXCLUDED.last_read_at
          )
      `, [chatId, user.id]);

      publish('read', { chat_id: chatId });

      const result = await db.query(`
        SELECT
          id,
          avito_message_id,
          direction,
          body,
          message_type,
          author_id,
          created_at
        FROM messages
        WHERE chat_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT 500
      `, [chatId]);

      return send(res, 200, {
        messages: result.rows
      });
    }

    // ОТПРАВКА И СОХРАНЕНИЕ СООБЩЕНИЯ
    if (messagesMatch && req.method === 'POST') {
      const chatId = Number(messagesMatch[1]);

      const chat = await allowedChat(db, user, chatId);

      if (!chat) {
        return send(res, 404, {
          error: 'Чат не найден'
        });
      }

      const body = await readBody(req);
      const text = String(body.text || '').trim();

      if (!text) {
        return send(res, 400, {
          error: 'Введите текст сообщения'
        });
      }

      if (text.length > 2000) {
        return send(res, 400, {
          error: 'Сообщение слишком длинное'
        });
      }

      const account = await getAccount();

      if (!account.id) {
        throw new Error('Не удалось определить аккаунт Avito');
      }

      // 1. Отправляем сообщение в Avito
      const response = await avitoRequest(
        `/messenger/v1/accounts/${account.id}/chats/${encodeURIComponent(chat.avito_chat_id)}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: {
              text
            },
            type: 'text'
          })
        }
      );

      const sent = response.message || response;
      const messageId = sent.id || response.id;

      if (!messageId) {
        console.error('AVITO SEND RESPONSE:', response);

        return send(res, 502, {
          error: 'Avito не вернул ID сообщения. Проверьте переписку перед повторной отправкой.'
        });
      }

      const created = sent.created
        ? new Date(Number(sent.created) * 1000)
        : new Date();

      // 2. Сохраняем исходящее сообщение.
      // ON CONFLICT защищает от повторного webhook.
      const saved = await db.query(`
        INSERT INTO messages (
          chat_id,
          avito_message_id,
          direction,
          body,
          message_type,
          author_id,
          created_at,
          raw
        )
        VALUES ($1, $2, 'out', $3, 'text', $4, $5, $6)
        ON CONFLICT (chat_id, avito_message_id)
        DO NOTHING
        RETURNING id
      `, [
        chatId,
        String(messageId),
        text,
        String(account.id),
        created,
        JSON.stringify(response)
      ]);

      // 3. Обновляем последнее сообщение чата.
      await db.query(`
        UPDATE chats
        SET
          last_message_id = $1,
          last_message_at = GREATEST(
            COALESCE(last_message_at, $2),
            $2
          ),
          last_synced_at = now(),
          updated_at = now()
        WHERE id = $3
      `, [
        String(messageId),
        created,
        chatId
      ]);

      // 4. Отправляем SSE только если сообщение
      // ещё не было сохранено входящим webhook.
      if (saved.rowCount > 0) {
        const assignment = await db.query(`
          SELECT manager_id
          FROM chat_assignments
          WHERE chat_id = $1
        `, [chatId]);

        const managerId = assignment.rows[0]?.manager_id;

        publish('message', {
          local_chat_id: String(chatId),
          chat_id: chat.avito_chat_id,
          message_id: String(messageId),
          direction: 'out',
          body: text,
          created_at: created.toISOString()
        }, client => {
          if (client.role === 'admin') return true;

          return managerId == null ||
            String(client.id) === String(managerId);
        });
      }

      console.log(
        `CRM MESSAGE: chat=${chatId}, message=${messageId}, saved=${saved.rowCount > 0}`
      );

      return send(res, 200, {
        success: true,
        message: {
          id: String(messageId),
          body: text,
          direction: 'out',
          created_at: created
        }
      });
    }

    return send(res, 404, {
      error: 'Маршрут не найден'
    });

  } catch (error) {
    console.error('CHATS ERROR:', error);

    return send(res, 500, {
      error: error.message || 'Ошибка работы с чатами'
    });
  }
}

module.exports = {
  handleChats
};
