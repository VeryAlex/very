
'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const COOKIE_NAME = 'vd_session';
const SESSION_DAYS = 90;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function authRoutes(app) {

  // Вход по email и паролю
  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = request.body || {};

    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email.trim() ||
      !password
    ) {
      return reply.code(400).send({
        error: 'Введите email и пароль'
      });
    }

    const result = await app.pg.query(
      `SELECT email, display_name, role, password_hash
       FROM crm_users
       WHERE email = $1`,
      [email.trim().toLowerCase()]
    );

    const user = result.rows[0];

    if (
      !user ||
      !user.password_hash ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return reply.code(401).send({
        error: 'Неверный email или пароль'
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);

    await app.pg.query(
      `INSERT INTO auth_sessions
       (token_hash, user_email, expires_at)
       VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [tokenHash, user.email]
    );

    reply.setCookie(COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SESSION_DAYS * 24 * 60 * 60
    });

    return {
      success: true,
      user: {
        email: user.email,
        display_name: user.display_name,
        role: user.role
      }
    };
  });

  // Проверка текущей сессии
  app.get('/api/auth/me', async (request, reply) => {
    const token = request.cookies[COOKIE_NAME];

    if (!token) {
      return reply.code(401).send({
        error: 'Не авторизован'
      });
    }

    const result = await app.pg.query(
      `SELECT u.email, u.display_name, u.role
       FROM auth_sessions s
       JOIN crm_users u ON u.email = s.user_email
       WHERE s.token_hash = $1
       AND s.expires_at > now()`,
      [hashToken(token)]
    );

    if (!result.rows.length) {
      reply.clearCookie(COOKIE_NAME, { path: '/' });

      return reply.code(401).send({
        error: 'Сессия истекла'
      });
    }

    return {
      success: true,
      user: result.rows[0]
    };
  });

  // Выход из аккаунта
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[COOKIE_NAME];

    if (token) {
      await app.pg.query(
        'DELETE FROM auth_sessions WHERE token_hash = $1',
        [hashToken(token)]
      );
    }

    reply.clearCookie(COOKIE_NAME, { path: '/' });

    return { success: true };
  });
}

module.exports = authRoutes;
