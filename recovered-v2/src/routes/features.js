'use strict';

const {
  authenticate,
  requireRole
} = require('../middleware/auth');

async function featuresRoutes(app) {

  // ==========================================
  // ПРОВЕРКА ДОСТУПА К ПРИВАТНОЙ ЗАМЕТКЕ
  // ==========================================

  async function checkChatAccess(request, chatId) {
    const result = await app.pg.query(
      `SELECT
         c.chat_id,
         ca.manager_email
       FROM chats c
       LEFT JOIN chat_assignments ca
         ON ca.chat_id = c.chat_id
       WHERE c.chat_id = $1
       LIMIT 1`,
      [chatId]
    );

    if (!result.rows.length) {
      return false;
    }

    if (request.user.role === 'admin') {
      return true;
    }

    return result.rows[0].manager_email === request.user.email;
  }


  // ==========================================
  // ПОЛУЧЕНИЕ ЗАМЕТКИ
  // ==========================================

  app.get('/chats/:chatId/note', {
    preHandler: [
      authenticate,
      requireRole('admin', 'manager')
    ]
  }, async (request, reply) => {

    const chatId = String(
      request.params.chatId || ''
    ).trim();

    if (!chatId || chatId.length > 200) {
      return reply.code(400).send({
        error: 'Некорректный ID чата'
      });
    }

    if (!await checkChatAccess(request, chatId)) {
      return reply.code(403).send({
        error: 'Нет доступа к заметке этого чата'
      });
    }

    const result = await app.pg.query(
      `SELECT
         note,
         updated_by,
         created_at,
         updated_at
       FROM chat_notes
       WHERE chat_id = $1`,
      [chatId]
    );

    return {
      success: true,
      chat_id: chatId,
      note: result.rows[0] || {
        note: '',
        updated_by: null,
        created_at: null,
        updated_at: null
      }
    };
  });


  // ==========================================
  // СОХРАНЕНИЕ ЗАМЕТКИ
  // ==========================================

  app.put('/chats/:chatId/note', {
    preHandler: [
      authenticate,
      requireRole('admin', 'manager')
    ]
  }, async (request, reply) => {

    const chatId = String(
      request.params.chatId || ''
    ).trim();

    const note = request.body?.note;

    if (!chatId || chatId.length > 200) {
      return reply.code(400).send({
        error: 'Некорректный ID чата'
      });
    }

    if (
      typeof note !== 'string' ||
      note.length > 5000
    ) {
      return reply.code(400).send({
        error: 'Заметка должна содержать не более 5000 символов'
      });
    }

    if (!await checkChatAccess(request, chatId)) {
      return reply.code(403).send({
        error: 'Нет доступа к заметке этого чата'
      });
    }

    const result = await app.pg.query(
      `INSERT INTO chat_notes (
         chat_id,
         note,
         updated_by
       )
       VALUES ($1, $2, $3)

       ON CONFLICT (chat_id)

       DO UPDATE SET
         note = EXCLUDED.note,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()

       RETURNING
         chat_id,
         note,
         updated_by,
         created_at,
         updated_at`,
      [
        chatId,
        note.trim(),
        request.user.email
      ]
    );

    return {
      success: true,
      note: result.rows[0]
    };
  });


  // ==========================================
  // ПОЛУЧЕНИЕ ОБЩИХ БЫСТРЫХ ОТВЕТОВ
  // ==========================================

  app.get('/quick-replies', {
    preHandler: [
      authenticate,
      requireRole('admin', 'manager')
    ]
  }, async () => {

    const result = await app.pg.query(
      `SELECT
         id,
         title,
         category,
         content,
         created_by,
         updated_by,
         created_at,
         updated_at
       FROM quick_replies
       ORDER BY category ASC, title ASC, id ASC`
    );

    return {
      success: true,
      quick_replies: result.rows
    };
  });


  // ==========================================
  // СОЗДАНИЕ БЫСТРОГО ОТВЕТА
  // ==========================================

  app.post('/quick-replies', {
    preHandler: [
      authenticate,
      requireRole('admin', 'manager')
    ]
  }, async (request, reply) => {

    const title = request.body?.title;
    const category = typeof request.body?.category === 'string' && request.body.category.trim() ? request.body.category.trim() : 'Общие';
    const content = request.body?.content;

    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.trim().length > 100
    ) {
      return reply.code(400).send({
        error: 'Название должно содержать от 1 до 100 символов'
      });
    }

    if (category.length > 60) {
      return reply.code(400).send({ error: 'Категория не должна превышать 60 символов' });
    }

    if (
      typeof content !== 'string' ||
      !content.trim() ||
      content.trim().length > 1000
    ) {
      return reply.code(400).send({
        error: 'Текст ответа должен содержать от 1 до 1000 символов'
      });
    }

    const result = await app.pg.query(
      `INSERT INTO quick_replies (
         title,
         category,
         content,
         created_by,
         updated_by
       )
       VALUES ($1, $2, $3, $4, $4)

       RETURNING
         id,
         title,
         category,
         content,
         created_by,
         updated_by,
         created_at,
         updated_at`,
      [
        title.trim(),
        category,
        content.trim(),
        request.user.email
      ]
    );

    return reply.code(201).send({
      success: true,
      quick_reply: result.rows[0]
    });
  });


  // ==========================================
  // РЕДАКТИРОВАНИЕ БЫСТРОГО ОТВЕТА
  // ==========================================

  app.put('/quick-replies/:id', {
    preHandler: [
      authenticate,
      requireRole('admin', 'manager')
    ]
  }, async (request, reply) => {

    const id = Number(request.params.id);

    const title = request.body?.title;
    const category = typeof request.body?.category === 'string' && request.body.category.trim() ? request.body.category.trim() : 'Общие';
    const content = request.body?.content;

    if (!Number.isSafeInteger(id) || id < 1) {
      return reply.code(400).send({
        error: 'Некорректный ID быстрого ответа'
      });
    }

    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.trim().length > 100
    ) {
      return reply.code(400).send({
        error: 'Название должно содержать от 1 до 100 символов'
      });
    }

    if (category.length > 60) {
      return reply.code(400).send({ error: 'Категория не должна превышать 60 символов' });
    }

    if (
      typeof content !== 'string' ||
      !content.trim() ||
      content.trim().length > 1000
    ) {
      return reply.code(400).send({
        error: 'Текст ответа должен содержать от 1 до 1000 символов'
      });
    }

    const result = await app.pg.query(
      `UPDATE quick_replies
       SET
         title = $2,
         category = $3,
         content = $4,
         updated_by = $5,
         updated_at = now()
       WHERE id = $1

       RETURNING
         id,
         title,
         category,
         content,
         created_by,
         updated_by,
         created_at,
         updated_at`,
      [
        id,
        title.trim(),
        category,
        content.trim(),
        request.user.email
      ]
    );

    if (!result.rows.length) {
      return reply.code(404).send({
        error: 'Быстрый ответ не найден'
      });
    }

    return {
      success: true,
      quick_reply: result.rows[0]
    };
  });


  // ==========================================
  // УДАЛЕНИЕ БЫСТРОГО ОТВЕТА
  // ==========================================

  app.delete('/quick-replies/:id', {
    preHandler: [
      authenticate,
      requireRole('admin', 'manager')
    ]
  }, async (request, reply) => {

    const id = Number(request.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return reply.code(400).send({
        error: 'Некорректный ID быстрого ответа'
      });
    }

    const result = await app.pg.query(
      `DELETE FROM quick_replies
       WHERE id = $1
       RETURNING id`,
      [id]
    );

    if (!result.rows.length) {
      return reply.code(404).send({
        error: 'Быстрый ответ не найден'
      });
    }

    return {
      success: true,
      deleted_id: id
    };
  });

}

module.exports = featuresRoutes;
