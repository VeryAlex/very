'use strict';

const { getUser } = require('../auth');
const { getAccount } = require('../services/avito');
const { uploadImage, sendImage } = require('../services/avito-images');
const { publish } = require('../services/realtime');

const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/heic': 'heic'
};

function isValidImage(buffer, mimeType) {
  if (buffer.length < 16) return false;

  if (mimeType === 'image/jpeg') {
    return buffer[0] === 0xFF &&
      buffer[1] === 0xD8 &&
      buffer[2] === 0xFF;
  }

  if (mimeType === 'image/png') {
    return buffer.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
  }

  if (mimeType === 'image/gif') {
    const signature = buffer.toString('ascii', 0, 6);
    return signature === 'GIF87a' || signature === 'GIF89a';
  }

  if (mimeType === 'image/bmp') {
    return buffer.toString('ascii', 0, 2) === 'BM';
  }

  if (mimeType === 'image/heic') {
    if (buffer.toString('ascii', 4, 8) !== 'ftyp') {
      return false;
    }

    const brand = buffer.toString('ascii', 8, 12);

    return ['heic', 'heix', 'hevc', 'hevx', 'mif1'].includes(brand);
  }

  return false;
}

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

async function handleChatImages(req, res, db, url) {
  const match = url.pathname.match(
    /^\/api\/chats\/(\d+)\/images$/
  );

  if (!match) return false;

  if (req.method !== 'POST') {
    return send(res, 405, { error: 'Метод не поддерживается' });
  }

  const user = await getUser(req, db);

  if (!user) {
    return send(res, 401, { error: 'Необходим вход' });
  }

  const chatId = Number(match[1]);

  const result = await db.query(`
    SELECT c.id, c.avito_chat_id, ca.manager_id
    FROM chats c
    LEFT JOIN chat_assignments ca ON ca.chat_id = c.id
    WHERE c.id = $1
      AND (
        $2 = 'admin'
        OR ca.manager_id IS NULL
        OR ca.manager_id = $3
      )
  `, [chatId, user.role, user.id]);

  const chat = result.rows[0];

  if (!chat) {
    return send(res, 404, { error: 'Чат не найден' });
  }

  if (
    user.role === 'manager' &&
    String(chat.manager_id) !== String(user.id)
  ) {
    return send(res, 403, {
      error: 'Сначала примите свободный чат'
    });
  }

  const mimeType = String(req.headers['x-image-type'] || '')
    .toLowerCase();

  if (!IMAGE_TYPES[mimeType]) {
    return send(res, 400, {
      error: 'Неподдерживаемый формат фотографии'
    });
  }

  const contentLength = Number(req.headers['content-length']);

  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 1 ||
    contentLength > MAX_IMAGE_SIZE
  ) {
    return send(res, 413, {
      error: 'Размер фотографии должен быть не более 20 МБ'
    });
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_IMAGE_SIZE) {
      return send(res, 413, {
        error: 'Фотография превышает 20 МБ'
      });
    }

    chunks.push(chunk);
  }

  if (!size || size !== contentLength) {
    return send(res, 400, {
      error: 'Некорректный размер фотографии'
    });
  }

  const buffer = Buffer.concat(chunks);

  if (!isValidImage(buffer, mimeType)) {
    return send(res, 400, {
      error: 'Содержимое файла не соответствует формату изображения'
    });
  }

  const filename = `photo.${IMAGE_TYPES[mimeType]}`;

  const account = await getAccount();

  if (!account.id) {
    throw new Error('Не удалось определить аккаунт Avito');
  }

  const imageId = await uploadImage(
    account.id,
    buffer,
    filename,
    mimeType
  );

  const response = await sendImage(
    account.id,
    chat.avito_chat_id,
    imageId
  );

  const message = response.message || response;

  if (!message.id) {
    return send(res, 502, {
      error: 'Avito не вернул ID сообщения. Проверьте переписку перед повторной отправкой.'
    });
  }

  const messageId = String(message.id);

  const created = message.created
    ? new Date(Number(message.created) * 1000)
    : new Date();

  // Сохраняем фотографию в базе данных.
  // ON CONFLICT предотвращает дублирование при webhook.
  try {
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
      VALUES ($1, $2, 'out', '', 'image', $3, $4, $5)
      ON CONFLICT (chat_id, avito_message_id)
      DO NOTHING
      RETURNING id
    `, [
      chatId,
      messageId,
      String(account.id),
      created,
      JSON.stringify(message)
    ]);

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
    `, [messageId, created, chatId]);

    if (saved.rowCount > 0) {
      publish('message', {
        local_chat_id: String(chatId),
        chat_id: chat.avito_chat_id,
        message_id: messageId,
        direction: 'out',
        body: '',
        created_at: created.toISOString()
      }, client => {
        if (client.role === 'admin') return true;

        return chat.manager_id == null ||
          String(client.id) === String(chat.manager_id);
      });
    }

    console.log(
      `CRM IMAGE: chat=${chatId}, message=${messageId}, saved=${saved.rowCount > 0}`
    );

  } catch (error) {
    console.error('CRM IMAGE SAVE ERROR:', error);

    return send(res, 502, {
      error: 'Фотография отправлена в Avito, но не сохранена в CRM. Проверьте переписку перед повторной отправкой.'
    });
  }

  return send(res, 200, {
    ok: true,
    message_id: messageId
  });
}

module.exports = { handleChatImages };
