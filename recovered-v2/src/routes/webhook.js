
'use strict';

const crypto = require('node:crypto');

async function webhookRoutes(app) {

  app.post('/webhooks/avito', async (request, reply) => {
    const envelope = request.body || {};
    const payload = envelope.payload || {};
    const message = payload.value || {};

    const eventKey = String(
      envelope.id ||
      crypto.createHash('sha256')
        .update(JSON.stringify(envelope))
        .digest('hex')
    );

    const eventType = String(payload.type || 'unknown');

    const chatId = String(message.chat_id || '').trim();
    const messageId = String(
      message.id || message.message_id || ''
    ).trim();

    const client = await app.pg.connect();

    try {
      await client.query('BEGIN');

      // Сохраняем оригинальное событие.
      const saved = await client.query(
        `INSERT INTO webhook_events (
           event_key,
           event_type,
           payload
         )
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (event_key) DO NOTHING
         RETURNING event_key`,
        [
          eventKey,
          eventType,
          JSON.stringify(envelope)
        ]
      );

      // Повторное уведомление — не обрабатываем.
      if (!saved.rows.length) {
        await client.query('COMMIT');

        return {
          success: true,
          duplicate: true
        };
      }

      // Обрабатываем только уведомления о сообщениях.
      if (
        eventType !== 'message' ||
        !chatId ||
        !messageId
      ) {
        await client.query(
          `UPDATE webhook_events
           SET processed_at = now()
           WHERE event_key = $1`,
          [eventKey]
        );

        await client.query('COMMIT');

        return { success: true };
      }

      const authorId = String(message.author_id || '');

      // Время сообщения Авито передаёт в Unix timestamp.
      let createdAt = new Date();

      if (message.created) {
        const value = Number(message.created);

        if (Number.isFinite(value)) {
          createdAt = new Date(
            value > 1000000000000
              ? value
              : value * 1000
          );
        } else {
          createdAt = new Date(message.created);
        }
      }

      if (Number.isNaN(createdAt.getTime())) {
        createdAt = new Date();
      }

      const direction =
        authorId === String(process.env.AVITO_USER_ID)
          ? 'out'
          : 'in';

      const messageType = String(
        message.type || 'unknown'
      );

      const textContent =
        message.content?.text ??
        message.text ??
        null;

      // Создаём чат, если его ещё нет.
      // Существующие данные чата сохраняются.
      await client.query(
        `INSERT INTO chats (
           chat_id,
           last_message_id,
           last_message_at,
           last_synced_at
         )
         VALUES ($1, $2, $3, now())
         ON CONFLICT (chat_id) DO NOTHING`,
        [
          chatId,
          messageId,
          createdAt
        ]
      );

      // Сохраняем сообщение.
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (chat_id, message_id) DO NOTHING`,
        [
          chatId,
          messageId,
          authorId,
          direction,
          messageType,
          textContent,
          createdAt,
          JSON.stringify(message)
        ]
      );

      // Обновляем последнее сообщение чата.
      await client.query(
        `UPDATE chats
         SET
           last_message_id = CASE
             WHEN last_message_at IS NULL
               OR last_message_at <= $3
             THEN $2
             ELSE last_message_id
           END,
           last_message_at = GREATEST(
             COALESCE(last_message_at, $3),
             $3
           ),
           last_synced_at = now(),
           updated_at = now()
         WHERE chat_id = $1`,
        [
          chatId,
          messageId,
          createdAt
        ]
      );

      // Отмечаем событие обработанным.
      await client.query(
        `UPDATE webhook_events
         SET processed_at = now()
         WHERE event_key = $1`,
        [eventKey]
      );

      await client.query('COMMIT');

      request.log.info({
        chat_id: chatId,
        message_id: messageId,
        direction
      }, 'Avito webhook message processed');

      return {
        success: true,
        processed: true
      };

    } catch (error) {
      await client.query('ROLLBACK');

      request.log.error({
        err: error
      }, 'Avito webhook processing failed');

      return reply.code(500).send({
        success: false
      });

    } finally {
      client.release();
    }
  });
}

module.exports = webhookRoutes;
