'use strict';

const { getUser } = require('../auth');
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

async function handleChatStatusAssignments(req, res, db, url) {
  const route = url.pathname;
  const match = route.match(
    /^\/api\/chat-status-assignments(?:\/(\d+))?$/
  );

  if (!match) return false;

  const user = await getUser(req, db);

  if (!user) {
    return send(res, 401, {
      error: 'Необходим вход'
    });
  }

  const chatId = match[1] ? Number(match[1]) : null;

  try {
    // Получение назначенных статусов
    if (req.method === 'GET' && chatId === null) {
      const result = await db.query(`
        SELECT
          a.chat_id,
          a.manager_id,
          a.status_id,
          a.updated_at,
          s.name AS status_name,
          u.display_name AS manager_name
        FROM manager_chat_status_assignments a
        JOIN manager_chat_statuses s
          ON s.id = a.status_id
        JOIN users u
          ON u.id = a.manager_id
        WHERE
          $1 = 'admin'
          OR (
            a.manager_id = $2
            AND EXISTS (
              SELECT 1
              FROM chats c
              LEFT JOIN chat_assignments ca
                ON ca.chat_id = c.id
              WHERE c.id = a.chat_id
                AND (
                  ca.manager_id IS NULL
                  OR ca.manager_id = $2
                )
            )
          )
        ORDER BY a.updated_at DESC
      `, [user.role, user.id]);

      return send(res, 200, {
        assignments: result.rows
      });
    }

    if (chatId === null) {
      return send(res, 405, {
        error: 'Метод не поддерживается'
      });
    }

    if (user.role !== 'manager') {
      return send(res, 403, {
        error: 'Изменение статусов доступно только менеджерам'
      });
    }

    // Проверяем доступ к чату
    const chat = await db.query(`
      SELECT c.id
      FROM chats c
      LEFT JOIN chat_assignments ca
        ON ca.chat_id = c.id
      WHERE c.id = $1
        AND (
          ca.manager_id IS NULL
          OR ca.manager_id = $2
        )
    `, [chatId, user.id]);

    if (!chat.rowCount) {
      return send(res, 404, {
        error: 'Чат не найден или недоступен'
      });
    }

    // Установка статуса
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const statusId = Number(body.status_id);

      if (!Number.isSafeInteger(statusId) || statusId <= 0) {
        return send(res, 400, {
          error: 'Некорректный идентификатор статуса'
        });
      }

      const result = await db.query(`
        INSERT INTO manager_chat_status_assignments
          (chat_id, manager_id, status_id)
        SELECT $1, $2, s.id
        FROM manager_chat_statuses s
        WHERE s.id = $3
          AND s.manager_id = $2
        ON CONFLICT (chat_id, manager_id)
        DO UPDATE SET
          status_id = EXCLUDED.status_id,
          updated_at = now()
        RETURNING chat_id, manager_id, status_id, updated_at
      `, [chatId, user.id, statusId]);

      if (!result.rowCount) {
        return send(res, 404, {
          error: 'Личный статус не найден'
        });
      }

      publish('chat-status', {
        chat_id: String(chatId),
        manager_id: String(user.id)
      }, client =>
        client.role === 'admin' ||
        String(client.id) === String(user.id)
      );

      return send(res, 200, {
        assignment: result.rows[0]
      });
    }

    // Снятие статуса
    if (req.method === 'DELETE') {
      await db.query(`
        DELETE FROM manager_chat_status_assignments
        WHERE chat_id = $1
          AND manager_id = $2
      `, [chatId, user.id]);

      publish('chat-status', {
        chat_id: String(chatId),
        manager_id: String(user.id)
      }, client =>
        client.role === 'admin' ||
        String(client.id) === String(user.id)
      );

      return send(res, 200, {
        success: true
      });
    }

    return send(res, 405, {
      error: 'Метод не поддерживается'
    });

  } catch (error) {
    if (error instanceof SyntaxError) {
      return send(res, 400, {
        error: 'Некорректный JSON'
      });
    }

    console.error('CHAT STATUS ASSIGNMENTS ERROR:', error);

    return send(res, 500, {
      error: 'Ошибка назначения статуса'
    });
  }
}

module.exports = {
  handleChatStatusAssignments
};
