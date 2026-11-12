
'use strict';

const {
  getAccount,
  getChats,
  getMessages
} = require('./avito');

const CHAT_LIMIT = 1000;
const PAGE_SIZE = 100;

function toDate(timestamp) {
  if (!timestamp) return null;
  return new Date(Number(timestamp) * 1000);
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
      last_message_id = EXCLUDED.last_message_id,
      last_message_at = EXCLUDED.last_message_at,
      last_synced_at = now(),
      raw = EXCLUDED.raw,
      updated_at = now()
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

  const localChatId = result.rows[0].id;

  for (const user of chat.users || []) {
    const profile = user.public_user_profile || {};

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
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (chat_id, avito_user_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        profile_url = EXCLUDED.profile_url,
        avatar_url = EXCLUDED.avatar_url,
        is_own_account = EXCLUDED.is_own_account,
        raw = EXCLUDED.raw
    `, [
      localChatId,
      String(user.id),
      user.name || '',
      profile.url || null,
      getAvatar(user),
      String(user.id) === String(accountId),
      user
    ]);
  }

  return localChatId;
}

// Полная загрузка истории одного чата
async function syncChatMessages(db, localChatId, avitoChatId) {
  let offset = 0;
  let saved = 0;

  while (true) {
    const response = await getMessages(avitoChatId, 100, offset);
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
async function syncLatestMessages(db, localChatId, avitoChatId) {
  const response = await getMessages(avitoChatId, 100, 0);
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
    const response = await getChats(pageSize, offset);
    const chats = response.chats || [];

    if (!chats.length) break;

    for (const chat of chats) {
      const localChatId = await saveChat(db, chat, account.id);

      chatsSaved++;

      messagesSaved += await syncChatMessages(
        db,
        localChatId,
        chat.id
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
    const response = await getChats(PAGE_SIZE, offset);
    const chats = response.chats || [];

    if (!chats.length) break;

    for (const chat of chats) {
      const existing = await db.query(`
        SELECT id, last_message_id
        FROM chats
        WHERE avito_chat_id = $1
      `, [String(chat.id)]);

      const isNew = existing.rowCount === 0;
      const oldMessageId = existing.rows[0]?.last_message_id;
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
          chat.id
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
