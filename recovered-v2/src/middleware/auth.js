
'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'vd_session';

// Хеширование токена сессии
function hashToken(token) {
  return crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');
}

// Проверка авторизации
async function authenticate(request, reply) {
  const token = request.cookies?.[COOKIE_NAME];

  if (!token) {
    return reply.code(401).send({
      error: 'Необходима авторизация'
    });
  }

  const result = await request.server.pg.query(
    `SELECT
       u.email,
       u.display_name,
       u.role
     FROM auth_sessions s
     JOIN crm_users u ON u.email = s.user_email
     WHERE s.token_hash = $1
       AND s.expires_at > now()
     LIMIT 1`,
    [hashToken(token)]
  );

  const user = result.rows[0];

  if (!user) {
    reply.clearCookie(COOKIE_NAME, { path: '/' });

    return reply.code(401).send({
      error: 'Сессия недействительна или истекла'
    });
  }

  request.user = user;
}

// Проверка прав доступа по роли
function requireRole(...allowedRoles) {
  return async function (request, reply) {
    if (!request.user) {
      return reply.code(401).send({
        error: 'Необходима авторизация'
      });
    }

    if (!allowedRoles.includes(request.user.role)) {
      return reply.code(403).send({
        error: 'Недостаточно прав доступа'
      });
    }
  };
}

module.exports = {
  authenticate,
  requireRole
};
