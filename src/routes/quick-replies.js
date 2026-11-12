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
    if (body.length > 12000) {
      throw new Error('Слишком большой запрос');
    }
  }

  return JSON.parse(body || '{}');
}

async function handleQuickReplies(req, res, db, url) {
  if (!url.pathname.startsWith('/api/quick-replies')) {
    return false;
  }

  const user = await getUser(req, db);

  if (!user) {
    send(res, 401, { error: 'Необходим вход' });
    return true;
  }

  try {
    // Получить все общие шаблоны
    if (url.pathname === '/api/quick-replies' &&
        req.method === 'GET') {
      const result = await db.query(`
        SELECT
          q.id,
          q.title,
          q.body,
          q.created_by,
          q.created_at,
          q.updated_at,
          u.display_name AS author
        FROM quick_replies q
        LEFT JOIN users u ON u.id = q.created_by
        ORDER BY lower(q.title), q.id
      `);

      send(res, 200, { replies: result.rows });
      return true;
    }

    // Создать шаблон
    if (url.pathname === '/api/quick-replies' &&
        req.method === 'POST') {
      const body = await readBody(req);
      const title = String(body.title || '').trim();
      const text = String(body.body || '').trim();

      if (!title || title.length > 100) {
        send(res, 400, { error: 'Название: от 1 до 100 символов' });
        return true;
      }

      if (!text || text.length > 2000) {
        send(res, 400, { error: 'Текст: от 1 до 2000 символов' });
        return true;
      }

      const result = await db.query(`
        INSERT INTO quick_replies (title, body, created_by)
        VALUES ($1, $2, $3)
        RETURNING id, title, body, created_by, created_at, updated_at
      `, [title, text, user.id]);

      publish('quick_replies', { action: 'changed' });

      send(res, 201, { success: true, reply: result.rows[0] });
      return true;
    }

    const match = url.pathname.match(
      /^\/api\/quick-replies\/(\d+)$/
    );

    if (match && req.method === 'PUT') {
      const id = Number(match[1]);
      const body = await readBody(req);
      const title = String(body.title || '').trim();
      const text = String(body.body || '').trim();

      if (!title || title.length > 100 ||
          !text || text.length > 2000) {
        send(res, 400, { error: 'Проверьте название и текст шаблона' });
        return true;
      }

      const result = await db.query(`
        UPDATE quick_replies
        SET title = $1, body = $2, updated_at = now()
        WHERE id = $3
        RETURNING id, title, body, created_by, created_at, updated_at
      `, [title, text, id]);

      if (!result.rowCount) {
        send(res, 404, { error: 'Шаблон не найден' });
        return true;
      }

      publish('quick_replies', { action: 'changed' });

      send(res, 200, { success: true, reply: result.rows[0] });
      return true;
    }

    if (match && req.method === 'DELETE') {
      const result = await db.query(
        'DELETE FROM quick_replies WHERE id = $1 RETURNING id',
        [Number(match[1])]
      );

      if (!result.rowCount) {
        send(res, 404, { error: 'Шаблон не найден' });
        return true;
      }

      publish('quick_replies', { action: 'changed' });

      send(res, 200, { success: true });
      return true;
    }

    send(res, 405, { error: 'Метод не поддерживается' });
    return true;

  } catch (error) {
    console.error('QUICK REPLIES ERROR:', error);

    send(res, 500, {
      error: 'Ошибка работы с быстрыми ответами'
    });

    return true;
  }
}

module.exports = { handleQuickReplies };
