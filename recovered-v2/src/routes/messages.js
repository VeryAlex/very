
'use strict';

const { authenticate, requireRole } = require('../middleware/auth');
const { sendMessage, uploadImage, sendImageMessage, getVoiceFiles } = require('../services/avito');

async function messagesRoutes(app) {

  // Получение истории сообщений конкретного чата
  app.get('/:chatId/messages', {
    preHandler: [
      authenticate,
      requireRole('admin', 'manager')
    ]
  }, async (request, reply) => {

    const chatId = String(request.params.chatId || '').trim();

    if (!chatId || chatId.length > 200) {
      return reply.code(400).send({
        error: 'Некорректный ID чата'
      });
    }

    const limit = Math.min(
      Math.max(Number(request.query.limit) || 50, 1),
      100
    );

    const before = request.query.before || null;

    const client = await app.pg.connect();

    try {
      const access = await client.query(
        `SELECT c.chat_id
         FROM chats c
         LEFT JOIN chat_assignments ca
           ON ca.chat_id = c.chat_id
         WHERE c.chat_id = $1
           AND (
             $2 = 'admin'
             OR ca.manager_email IS NULL
             OR ca.manager_email = $3
           )
         LIMIT 1`,
        [
          chatId,
          request.user.role,
          request.user.email
        ]
      );

      if (!access.rows.length) {
        return reply.code(404).send({
          error: 'Чат не найден или доступ запрещён'
        });
      }

      const params = [chatId];
      let cursorFilter = '';

      if (before) {
        const separator = before.lastIndexOf('|');

        if (separator === -1) {
          return reply.code(400).send({
            error: 'Некорректный курсор сообщений'
          });
        }

        const timestamp = before.slice(0, separator);
        const messageId = before.slice(separator + 1);
        const date = new Date(timestamp);

        if (Number.isNaN(date.getTime()) || !messageId) {
          return reply.code(400).send({
            error: 'Некорректный курсор сообщений'
          });
        }

        params.push(date.toISOString(), messageId);

        cursorFilter = `
          AND (created_at, message_id) < ($2::timestamptz, $3::text)
        `;
      }

      params.push(limit);

      const result = await client.query(
        `SELECT
           message_id,
           author_id,
           direction,
           message_type,
           text_content,
           created_at,
           raw
         FROM messages
         WHERE chat_id = $1
         ${cursorFilter}
         ORDER BY created_at DESC NULLS LAST, message_id DESC
         LIMIT $${params.length}`,
        params
      );

      const messages = result.rows.reverse();
      const oldest = messages[0];

      const nextCursor = oldest
        ? `${oldest.created_at.toISOString()}|${oldest.message_id}`
        : null;

      return {
        success: true,
        chat_id: chatId,
        messages,
        pagination: {
          limit,
          has_more: messages.length === limit,
          next_cursor: nextCursor
        }
      };

    } finally {
      client.release();
    }
  });


  // Голосовые файлы: ссылки Авито краткоживущие, выдаём только авторизованным пользователям с доступом к чату.
  app.post('/:chatId/voice-files', {
    preHandler: [authenticate, requireRole('admin', 'manager')]
  }, async (request, reply) => {
    const chatId = String(request.params.chatId || '').trim();
    const voiceIds = request.body?.voice_ids;
    if (!chatId || chatId.length > 200 || !Array.isArray(voiceIds) || !voiceIds.length || voiceIds.length > 20) {
      return reply.code(400).send({ error: 'Некорректные параметры голосовых файлов' });
    }
    const access = await app.pg.query(`SELECT ca.manager_email FROM chats c LEFT JOIN chat_assignments ca ON ca.chat_id=c.chat_id WHERE c.chat_id=$1`, [chatId]);
    if (!access.rows.length) return reply.code(404).send({ error: 'Чат не найден' });
    if (request.user.role === 'manager' && access.rows[0].manager_email !== request.user.email) {
      return reply.code(403).send({ error: 'Сначала закрепите чат за собой' });
    }
    try {
      return { success: true, files: await getVoiceFiles(voiceIds) };
    } catch (error) {
      request.log.error({ err: error, chat_id: chatId }, 'Voice file lookup failed');
      return reply.code(502).send({ error: 'Не удалось получить голосовой файл Авито' });
    }
  });

  async function assertCanSend(client, request, chatId) {
    // Строка чата блокируется до окончания запроса к Авито: администраторское переназначение не обгонит отправку.
    const result = await client.query(
      `SELECT c.chat_id, ca.manager_email
       FROM chats c LEFT JOIN chat_assignments ca ON ca.chat_id=c.chat_id
       WHERE c.chat_id=$1 FOR UPDATE OF c`, [chatId]
    );
    if (!result.rows.length) return { ok: false, status: 404, error: 'Чат не найден' };
    if (request.user.role === 'manager' && result.rows[0].manager_email !== request.user.email) {
      return { ok: false, status: 403, error: 'Сначала закрепите чат за собой' };
    }
    return { ok: true };
  }

  async function persistSentMessage(client, chatId, avitoResult, messageType, textContent, rawFallback) {
    const messageId = avitoResult?.id || avitoResult?.message_id || avitoResult?.result?.id;
    if (!messageId) throw new Error('Avito returned no message ID');
    const rawMessage = avitoResult.result || avitoResult;
    const createdValue = avitoResult.created || avitoResult.created_at || avitoResult.result?.created;
    let createdAt = new Date();
    if (createdValue) {
      const parsed = Number(createdValue);
      createdAt = new Date(Number.isFinite(parsed) && parsed > 1000000000 ? parsed * 1000 : createdValue);
      if (Number.isNaN(createdAt.getTime())) createdAt = new Date();
    }
    await client.query(
      `INSERT INTO messages (chat_id,message_id,author_id,direction,message_type,text_content,created_at,raw)
       VALUES ($1,$2,$3,'out',$4,$5,$6,$7::jsonb)
       ON CONFLICT (chat_id,message_id) DO NOTHING`,
      [chatId, String(messageId), String(rawMessage.author_id || process.env.AVITO_USER_ID), messageType, textContent, createdAt, JSON.stringify(rawMessage || rawFallback || {})]
    );
    await client.query(`UPDATE chats SET last_message_id=$2,last_message_at=$3,updated_at=now() WHERE chat_id=$1`, [chatId, String(messageId), createdAt]);
    return { message_id: String(messageId), direction: 'out', message_type: messageType, text_content: textContent, created_at: createdAt, raw: rawMessage };
  }

  // Отправка текста. Администратор может писать в любой чат; менеджер — только после назначения на себя.
  app.post('/:chatId/messages', {
    preHandler: [authenticate, requireRole('admin', 'manager')]
  }, async (request, reply) => {
    const chatId = String(request.params.chatId || '').trim();
    const text = request.body?.text;
    if (!chatId || chatId.length > 200) return reply.code(400).send({ error: 'Некорректный ID чата' });
    if (typeof text !== 'string' || !text.trim() || text.trim().length > 1000) return reply.code(400).send({ error: 'Сообщение должно содержать от 1 до 1000 символов' });
    const client = await app.pg.connect();
    let sent = false;
    try {
      await client.query('BEGIN');
      const access = await assertCanSend(client, request, chatId);
      if (!access.ok) { await client.query('ROLLBACK'); return reply.code(access.status).send({ error: access.error }); }
      let result;
      try { result = await sendMessage(chatId, text.trim()); sent = true; }
      catch (error) { await client.query('ROLLBACK'); request.log.error({ err: error, chat_id: chatId }, 'Avito message sending failed'); return reply.code(502).send({ error: 'Не удалось подтвердить отправку сообщения в Авито', retry_allowed: false }); }
      let message;
      try { message = await persistSentMessage(client, chatId, result, 'text', text.trim()); }
      catch (error) { await client.query('ROLLBACK'); request.log.error({ err: error, chat_id: chatId }, 'Message sent but persistence failed'); return reply.code(502).send({ error: 'Сообщение отправлено в Авито, но не сохранено в CRM. Не повторяйте отправку.', sent: true, stored: false }); }
      await client.query('COMMIT');
      return { success: true, sent: true, stored: true, chat_id: chatId, message };
    } catch (error) {
      if (!sent) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  });

  // Загрузка и отправка одной фотографии.
  app.post('/:chatId/messages/image', {
    preHandler: [authenticate, requireRole('admin', 'manager')]
  }, async (request, reply) => {
    const chatId = String(request.params.chatId || '').trim();
    if (!chatId || chatId.length > 200) return reply.code(400).send({ error: 'Некорректный ID чата' });
    let part;
    try { part = await request.file(); } catch (error) { return reply.code(400).send({ error: 'Не удалось прочитать файл' }); }
    if (!part) return reply.code(400).send({ error: 'Выберите изображение' });
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(part.mimetype)) return reply.code(415).send({ error: 'Поддерживаются JPG, PNG, WEBP и GIF' });
    let buffer;
    try { buffer = await part.toBuffer(); } catch (error) { return reply.code(413).send({ error: 'Файл превышает лимит 24 МБ' }); }
    const client = await app.pg.connect();
    let sent = false;
    try {
      await client.query('BEGIN');
      const access = await assertCanSend(client, request, chatId);
      if (!access.ok) { await client.query('ROLLBACK'); return reply.code(access.status).send({ error: access.error }); }
      let upload;
      try { upload = await uploadImage(buffer, part.filename, part.mimetype); }
      catch (error) { await client.query('ROLLBACK'); request.log.error({ err: error }, 'Avito image upload failed'); return reply.code(502).send({ error: 'Авито не приняло изображение' }); }
      const imageId = upload?.image_id || upload?.id || upload?.result?.image_id || upload?.result?.id || upload?.images?.[0]?.image_id || upload?.images?.[0]?.id;
      if (!imageId) { await client.query('ROLLBACK'); return reply.code(502).send({ error: 'Авито загрузило файл без идентификатора изображения' }); }
      let result;
      try { result = await sendImageMessage(chatId, imageId); sent = true; }
      catch (error) { await client.query('ROLLBACK'); request.log.error({ err: error }, 'Avito image send failed'); return reply.code(502).send({ error: 'Изображение загружено, но отправка в чат не подтверждена', retry_allowed: false }); }
      const message = await persistSentMessage(client, chatId, result, 'image', null, { image_id: imageId });
      await client.query('COMMIT');
      return { success: true, sent: true, stored: true, chat_id: chatId, message };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      request.log.error({ err: error, chat_id: chatId, sent }, 'Image send flow failed');
      return reply.code(502).send({ error: sent ? 'Изображение отправлено, но не удалось сохранить в CRM. Не отправляйте повторно.' : 'Не удалось отправить изображение', sent, stored: false });
    } finally { client.release(); }
  });

}

module.exports = messagesRoutes;
