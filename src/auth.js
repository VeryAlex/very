
'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 90;
const COOKIE_NAME = 'vd_session';

let bcrypt = null;
try {
  bcrypt = require('bcryptjs');
} catch {}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);

  return `scrypt$${salt}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (stored.startsWith('scrypt$')) {
    const [, salt, expected] = stored.split('$');
    const actual = await scrypt(password, salt, 64);
    const expectedBuffer = Buffer.from(expected, 'hex');

    return expectedBuffer.length === actual.length &&
      crypto.timingSafeEqual(actual, expectedBuffer);
  }

  if (bcrypt && /^\$2[aby]\$/.test(stored)) {
    return bcrypt.compare(password, stored);
  }

  return false;
}

function cookies(req) {
  const result = {};

  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    result[key] = value;
  }

  return result;
}

function setCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production'
    ? '; Secure'
    : '';

  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
}

function clearCookie(res) {
  const secure = process.env.NODE_ENV === 'production'
    ? '; Secure'
    : '';

  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  );
}

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

async function getUser(req, db) {
  const token = cookies(req)[COOKIE_NAME];
  if (!token) return null;

  const tokenHash = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  const result = await db.query(`
    SELECT u.id, u.email, u.display_name, u.role
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1
      AND s.expires_at > now()
      AND u.is_active = TRUE
  `, [tokenHash]);

  return result.rows[0] || null;
}

async function createSession(user, db, res) {
  const token = crypto.randomBytes(32).toString('hex');

  const tokenHash = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  await db.query(`
    INSERT INTO auth_sessions (token_hash, user_id, expires_at)
    VALUES ($1, $2, now() + interval '90 days')
  `, [tokenHash, user.id]);

  setCookie(res, token);
}

async function handleAuth(req, res, db, url) {
  const route = url.pathname;
  const method = req.method;

  if (route === '/api/auth/login' && method === 'POST') {
    try {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!email || !password) {
        return send(res, 400, { error: 'Введите email и пароль' });
      }

      const result = await db.query(`
        SELECT id, email, display_name, role, password_hash
        FROM users
        WHERE lower(email) = $1 AND is_active = TRUE
      `, [email]);

      const user = result.rows[0];

      if (!user || !(await verifyPassword(password, user.password_hash))) {
        return send(res, 401, { error: 'Неверный email или пароль' });
      }

      await createSession(user, db, res);

      return send(res, 200, {
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          role: user.role
        }
      });
    } catch (error) {
      console.error('LOGIN ERROR:', error);
      return send(res, 500, { error: 'Ошибка авторизации' });
    }
  }

  if (route === '/api/auth/logout' && method === 'POST') {
    try {
      const token = cookies(req)[COOKIE_NAME];

      if (token) {
        const hash = crypto.createHash('sha256')
          .update(token).digest('hex');

        await db.query(
          'DELETE FROM auth_sessions WHERE token_hash = $1',
          [hash]
        );
      }

      clearCookie(res);
      return send(res, 200, { success: true });
    } catch {
      clearCookie(res);
      return send(res, 500, { error: 'Ошибка выхода' });
    }
  }

  if (route === '/api/auth/me' && method === 'GET') {
    try {
      const user = await getUser(req, db);

      if (!user) {
        return send(res, 401, { error: 'Необходим вход' });
      }

      return send(res, 200, { user });
    } catch (error) {
      console.error('AUTH CHECK ERROR:', error);
      return send(res, 500, { error: 'Ошибка проверки сессии' });
    }
  }

  if (route.startsWith('/api/admin/users')) {
    let user;

    try {
      user = await getUser(req, db);
    } catch {
      return send(res, 500, { error: 'Ошибка проверки доступа' });
    }

    if (!user) {
      return send(res, 401, { error: 'Необходим вход' });
    }

    if (user.role !== 'admin') {
      return send(res, 403, { error: 'Недостаточно прав' });
    }

    if (route === '/api/admin/users' && method === 'GET') {
      try {
        const result = await db.query(`
          SELECT id, email, display_name, role, is_active
          FROM users
          ORDER BY created_at
        `);

        return send(res, 200, { users: result.rows });
      } catch {
        return send(res, 500, { error: 'Ошибка загрузки пользователей' });
      }
    }

    if (route === '/api/admin/users' && method === 'POST') {
      try {
        const body = await readBody(req);
        const name = String(body.display_name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');

        if (!name || !email || !email.includes('@')) {
          return send(res, 400, { error: 'Проверьте имя и email' });
        }

        if (password.length < 12) {
          return send(res, 400, {
            error: 'Пароль должен содержать минимум 12 символов'
          });
        }

        const passwordHash = await hashPassword(password);

        const result = await db.query(`
          INSERT INTO users
            (email, display_name, role, password_hash)
          VALUES ($1, $2, 'manager', $3)
          RETURNING id, email, display_name, role, is_active
        `, [email, name, passwordHash]);

        return send(res, 201, { user: result.rows[0] });
      } catch (error) {
        if (error.code === '23505') {
          return send(res, 409, { error: 'Этот email уже используется' });
        }

        console.error('CREATE USER ERROR:', error);
        return send(res, 500, { error: 'Не удалось создать менеджера' });
      }
    }

    const match = route.match(
      /^\/api\/admin\/users\/(\d+)\/(active|deactivate)$/
    );

    if (match && method === 'POST') {
      try {
        const [, id, action] = match;
        const active = action === 'active';

        const result = await db.query(`
          UPDATE users
          SET is_active = $1, updated_at = now()
          WHERE id = $2 AND role = 'manager'
          RETURNING id
        `, [active, id]);

        if (!result.rowCount) {
          return send(res, 404, { error: 'Менеджер не найден' });
        }

        if (!active) {
          await db.query(
            'DELETE FROM auth_sessions WHERE user_id = $1',
            [id]
          );
        }

        return send(res, 200, { success: true });
      } catch (error) {
        console.error('UPDATE USER ERROR:', error);
        return send(res, 500, { error: 'Ошибка изменения пользователя' });
      }
    }
  }

  return false;
}

module.exports = {
  handleAuth,
  getUser
};