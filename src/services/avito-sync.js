
'use strict';

const {
  getAccount,
  getChats,
  getMessages
} = require('./avito');

const { avitoDate } = require('./avito-time');

const CHAT_LIMIT = 1000;
const PAGE_SIZE = 100;

function toDate(timestamp) {
  return avitoDate(timestamp);
}

function getAvatar(user) {
  const avatar = user.public_user_profile?.avatar;

  return avatar?.images?.['256x256'] ||
    avatar?.images?.['192x192'] ||
    avatar?.default ||
    null;
}

function getMessageBody(message) {
  const content = message.content || {};

  return content.text ||
    content.link?.text ||
    content.location?.text ||
    '';
}

async function saveMessage(db, chatId, message) {
  if (!message.id || !['in', 'out'].includes(message.direction)) {
    return false;
  }

  await db.query(`
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
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (chat_id, avito_message_id)
    DO UPDATE SET
      body = EXCLUDED.body,
      message_type = EXCLUDED.message_type,
      author_id = EXCLUDED.author_id,
      raw = EXCLUDED.raw
  `, [
    chatId,
    String(message.id),
    message.direction,
    getMessageBody(message),
    message.type || 'text',
    message.author_id ? String(message.author_id) : null,
    toDate(message.created),
    message
  ]);

  return true;
}

async function saveChat(db, chat, accountId) {
  const context = chat.context?.value || {};

  const peer = chat.users?.find(
    user => String(user.id) !== String(accountId)
  );

  const image = context.images?.main || {};
  const lastMessage = chat.last_message || {};

  const result = await db.query(`
    INSERT INTO chats (
      avito_chat_id,
      peer_id,
      peer_name,
      item_id,
      item_title,
      item_url,
      item_image_url,
      item_price,
      last_message_id,
      last_message_at,
      last_synced_at,
      raw,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,now())
    ON CONFLICT (avito_chat_id)
    DO UPDATE SET
      peer_id = EXCLUDED.peer_id,
      peer_name = EXCLUDED.peer_name,
      item_id = EXCLUDED.item_id,
      item_title = EXCLUDED.item_title,
      item_url = EXCLUDED.item_url,
      item_image_url = EXCLUDED.item_image_url,
      item_price = EXCLUDED.item_price,

      last_message_id = CASE
        WHEN EXCLUDED.last_message_id IS NOT NULL
          AND (
            chats.last_message_at IS NULL
            OR EXCLUDED.last_message_at >= chats.last_message_at
          )
        THEN EXCLUDED.last_message_id
        ELSE chats.last_message_id
      END,

      last_message_at = CASE
        WHEN EXCLUDED.last_message_id IS NOT NULL
          AND (
            chats.last_message_at IS NULL
            OR EXCLUDED.last_message_at >= chats.last_message_at
          )
        THEN EXCLUDED.last_message_at
        ELSE chats.last_message_at
      END,

      last_synced_at = now(),
      updated_at = now()

    WHERE
      (
        chats.peer_id,
        chats.peer_name,
        chats.item_id,
        chats.item_title,
        chats.item_url,
        chats.item_image_url,
        chats.item_price
      ) IS DISTINCT FROM (
        EXCLUDED.peer_id,
        EXCLUDED.peer_name,
        EXCLUDED.item_id,
        EXCLUDED.item_title,
        EXCLUDED.item_url,
        EXCLUDED.item_image_url,
        EXCLUDED.item_price
      )
      OR (
        EXCLUDED.last_message_id IS NOT NULL
        AND (
          chats.last_message_at IS NULL
          OR EXCLUDED.last_message_at >= chats.last_message_at
        )
        AND (
          chats.last_message_id IS DISTINCT FROM EXCLUDED.last_message_id
          OR chats.last_message_at IS DISTINCT FROM EXCLUDED.last_message_at
        )
      )

    RETURNING id
  `, [
    String(chat.id),
    peer ? String(peer.id) : null,
    peer?.name || '',
    context.id ? String(context.id) : null,
    context.title || '',
    context.url || null,
    image['140x105'] || null,
    context.price_string || null,
    lastMessage.id ? String(lastMessage.id) : null,
    toDate(lastMessage.created || chat.updated),
    chat
  ]);

  let localChatId = result.rows[0]?.id;

  // Если UPDATE пропущен из-за отсутствия изменений,
  // получаем ID существующего чата отдельным SQL-запросом.
  if (!localChatId) {
    const existingChat = await db.query(
      'SELECT id FROM chats WHERE avito_chat_id = $1',
      [String(chat.id)]
    );

    if (!existingChat.rowCount) {
      throw new Error(
        `Не удалось получить localChatId для Avito chat ${chat.id}`
      );
    }

    localChatId = existingChat.rows[0].id;
  }

  const participants = (chat.users || []).map(user => {
    const profile = user.public_user_profile || {};

    return [
      localChatId,
      String(user.id),
      user.name || '',
      profile.url || null,
      getAvatar(user),
      String(user.id) === String(accountId),
      JSON.stringify(user)
    ];
  });

  if (participants.length) {
    const values = [];
    const params = [];

    for (const participant of participants) {
      const placeholders = participant.map((_, index) => {
        params.push(participant[index]);
        return `$${params.length}`;
      });

      values.push(`(${placeholders.join(',')})`);
    }

    await db.query(`
      INSERT INTO chat_participants (
        chat_id,
        avito_user_id,
        name,
        profile_url,
        avatar_url,
        is_own_account,
        raw
      )
      VALUES ${values.join(',')}
      ON CONFLICT (chat_id, avito_user_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        profile_url = EXCLUDED.profile_url,
        is_own_account = EXCLUDED.is_own_account
      WHERE (
        chat_participants.name,
        chat_participants.profile_url,
        chat_participants.is_own_account
      ) IS DISTINCT FROM (
        EXCLUDED.name,
        EXCLUDED.profile_url,
        EXCLUDED.is_own_account
      )
    `, params);
  }

  return localChatId;
}

// Полная загрузка истории одного чата
async function syncChatMessages(db, localChatId, avitoChatId, accountId) {
  let offset = 0;
  let saved = 0;

  while (true) {
    const response = await getMessages(avitoChatId, 100, offset, accountId);
    const messages = response.messages || [];

    for (const message of messages) {
      if (await saveMessage(db, localChatId, message)) {
        saved++;
      }
    }

    if (!response.meta?.has_more || messages.length === 0) {
      break;
    }

    offset += messages.length;
  }

  return saved;
}

// Только последние сообщения — для фонового обновления
async function syncLatestMessages(db, localChatId, avitoChatId, accountId) {
  const response = await getMessages(avitoChatId, 100, 0, accountId);
  const messages = response.messages || [];

  let saved = 0;

  for (const message of messages) {
    if (await saveMessage(db, localChatId, message)) {
      saved++;
    }
  }

  return saved;
}

// Первоначальный импорт с ограничением 1000 чатов
async function syncAvito(db, options = {}) {
  const requestedMaxChats = options.maxChats ?? CHAT_LIMIT;
  const maxChats = Math.min(requestedMaxChats, CHAT_LIMIT);

  if (!Number.isInteger(maxChats) || maxChats <= 0) {
    throw new Error('Некорректное ограничение maxChats');
  }

  console.log('AVITO SYNC: initial import started');

  const account = await getAccount();

  if (!account.id) {
    throw new Error('Не удалось определить аккаунт Avito');
  }

  let offset = 0;
  let chatsSaved = 0;
  let messagesSaved = 0;

  while (chatsSaved < maxChats) {
    const pageSize = Math.min(PAGE_SIZE, maxChats - chatsSaved);
    const response = await getChats(pageSize, offset, account.id);
    const chats = response.chats || [];

    if (!chats.length) break;

    for (const chat of chats) {
      const localChatId = await saveChat(db, chat, account.id);

      chatsSaved++;

      messagesSaved += await syncChatMessages(
        db,
        localChatId,
        chat.id,
        account.id
      );

      if (chatsSaved >= maxChats) break;
    }

    console.log(
      `AVITO INITIAL: chats=${chatsSaved}, messages=${messagesSaved}`
    );

    if (!response.meta?.has_more) break;

    offset += chats.length;
  }

  return {
    success: true,
    chats: chatsSaved,
    messages: messagesSaved
  };
}

// Фоновая проверка последних 1000 чатов
async function syncRecentAvito(db) {
  console.log('AVITO POLL: started');

  const account = await getAccount();

  if (!account.id) {
    throw new Error('Не удалось определить аккаунт Avito');
  }

  let offset = 0;
  let checked = 0;
  let changed = 0;
  let messagesSaved = 0;

  while (checked < CHAT_LIMIT) {
    const response = await getChats(PAGE_SIZE, offset, account.id);
    const chats = response.chats || [];

    if (!chats.length) break;

    // Получаем существующие чаты одной пакетной SQL-операцией.
    const avitoChatIds = chats.map(chat => String(chat.id));

    const existingResult = await db.query(`
      SELECT avito_chat_id, id, last_message_id
      FROM chats
      WHERE avito_chat_id = ANY($1::text[])
    `, [avitoChatIds]);

    const existingChats = new Map(
      existingResult.rows.map(row => [
        row.avito_chat_id,
        row
      ])
    );

    for (const chat of chats) {
      const existing = existingChats.get(String(chat.id));

      const isNew = !existing;
      const oldMessageId = existing?.last_message_id;
      const newMessageId = chat.last_message?.id
        ? String(chat.last_message.id)
        : null;

      const hasNewMessage =
        newMessageId && newMessageId !== oldMessageId;

      const localChatId = await saveChat(db, chat, account.id);

      if (isNew || hasNewMessage) {
        messagesSaved += await syncLatestMessages(
          db,
          localChatId,
          chat.id,
          account.id
        );

        changed++;
      }

      checked++;
    }

    if (!response.meta?.has_more) break;

    offset += chats.length;
  }

  const result = {
    success: true,
    checked,
    changed,
    messages: messagesSaved
  };

  console.log('AVITO POLL: completed', result);

  return result;
}

module.exports = {
  syncAvito,
  syncRecentAvito
};
