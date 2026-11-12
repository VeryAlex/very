'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const Fastify = require('fastify');
const cookie = require('@fastify/cookie');
const multipart = require('@fastify/multipart');

const { pool } = require('./db');

const authRoutes = require('./routes/auth');
const chatsRoutes = require('./routes/chats');
const messagesRoutes = require('./routes/messages');
const featuresRoutes = require('./routes/features');
const webhookRoutes = require('./routes/webhook');

const {
  authenticate,
  requireRole
} = require('./middleware/auth');

const app = Fastify({
  logger: true,
  bodyLimit: 30 * 1024 * 1024
});

// PostgreSQL
app.decorate('pg', pool);

// Cookies
app.register(cookie);
app.register(multipart, { limits: { fileSize: 24 * 1024 * 1024, files: 1 } });

// Интерфейс
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function sendPublicFile(reply, filename, contentType) {
  try {
    const filePath = path.join(PUBLIC_DIR, filename);
    const content = await fs.readFile(filePath);

    return reply
      .type(contentType)
      .header('Cache-Control', 'no-cache')
      .send(content);

  } catch (error) {
    app.log.error(error);

    return reply.code(404).send({
      error: 'Файл интерфейса не найден'
    });
  }
}

app.get('/', async (request, reply) => {
  return sendPublicFile(
    reply,
    'index.html',
    'text/html; charset=utf-8'
  );
});

app.get('/style.css', async (request, reply) => {
  return sendPublicFile(
    reply,
    'style.css',
    'text/css; charset=utf-8'
  );
});

app.get('/app.js', async (request, reply) => {
  return sendPublicFile(reply, 'app.js', 'application/javascript; charset=utf-8');
});

app.get('/crm-tools.js', async (request, reply) => {
  return sendPublicFile(reply, 'crm-tools.js', 'application/javascript; charset=utf-8');
});

// Проверка сервера
app.get('/health', async (request, reply) => {
  try {
    await pool.query('SELECT 1');

    return {
      status: 'ok',
      service: 'Very Delivery CRM V2',
      database: 'connected'
    };

  } catch (error) {
    request.log.error(error);

    return reply.code(503).send({
      status: 'error',
      database: 'disconnected'
    });
  }
});

// Авторизация
app.register(authRoutes);

// Чаты
app.register(chatsRoutes, {
  prefix: '/api/chats'
});

// Сообщения
app.register(messagesRoutes, {
  prefix: '/api/chats'
});

// Заметки и быстрые ответы
app.register(featuresRoutes, {
  prefix: '/api'
});

// Webhook Авито
app.register(webhookRoutes);

// Проверка администратора
app.get('/api/admin/check', {
  preHandler: [
    authenticate,
    requireRole('admin')
  ]
}, async (request) => {
  return {
    success: true,
    message: 'Доступ администратора подтверждён',
    user: request.user
  };
});

// Проверка менеджера
app.get('/api/manager/check', {
  preHandler: [
    authenticate,
    requireRole('manager')
  ]
}, async (request) => {
  return {
    success: true,
    message: 'Доступ менеджера подтверждён',
    user: request.user
  };
});

// Закрытие соединений
app.addHook('onClose', async () => {
  await pool.end();
});

// Запуск
async function start() {
  try {
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || '0.0.0.0';

    await app.listen({
      port,
      host
    });

    app.log.info(`CRM V2 started on port ${port}`);

  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
