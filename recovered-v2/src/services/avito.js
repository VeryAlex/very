
'use strict';

const AVITO_BASE_URL = 'https://api.avito.ru';

let cachedToken = null;
let tokenExpiresAt = 0;
let tokenPromise = null;

// Получение OAuth-токена с кешированием
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  // Не допускаем одновременный запрос нескольких токенов
  if (tokenPromise) {
    return tokenPromise;
  }

  tokenPromise = (async () => {
    const clientId = process.env.AVITO_CLIENT_ID;
    const clientSecret = process.env.AVITO_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Avito credentials are missing');
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    });

    const response = await fetch(
      `${AVITO_BASE_URL}/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body,
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      throw new Error(
        `Avito OAuth error: HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (!data.access_token) {
      throw new Error('Avito OAuth returned no access token');
    }

    cachedToken = data.access_token;

    const expiresIn = Number(data.expires_in || 86400);

    tokenExpiresAt = Date.now() + expiresIn * 1000;

    return cachedToken;
  })();

  try {
    return await tokenPromise;
  } finally {
    tokenPromise = null;
  }
}

// Универсальный запрос к Avito API
async function avitoRequest(path, options = {}) {
  const token = await getAccessToken();

  const response = await fetch(
    `${AVITO_BASE_URL}${path}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body && !(typeof FormData !== 'undefined' && options.body instanceof FormData) ? {
          'Content-Type': 'application/json'
        } : {}),
        ...options.headers
      },
      signal: options.signal || AbortSignal.timeout(15000)
    }
  );

  if (response.status === 401) {
    cachedToken = null;
    tokenExpiresAt = 0;
  }

  if (!response.ok) {
    throw new Error(
      `Avito API error: HTTP ${response.status}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

// Получение информации об аккаунте
async function getAccount() {
  return avitoRequest('/core/v1/accounts/self');
}


// Получение списка чатов
async function getChats(params = {}) {
  const query = new URLSearchParams();

  query.set('limit', String(params.limit || 100));
  query.set('offset', String(params.offset || 0));

  if (params.unreadOnly) {
    query.set('unread_only', 'true');
  }

  if (params.chatTypes) {
    query.set('chat_types', params.chatTypes);
  }

  return avitoRequest(
    `/messenger/v2/accounts/${process.env.AVITO_USER_ID}/chats?${query}`
  );
}


// Получение истории сообщений
async function getMessages(chatId, params = {}) {
  const query = new URLSearchParams();

  query.set('limit', String(params.limit || 100));
  query.set('offset', String(params.offset || 0));

  return avitoRequest(
    `/messenger/v3/accounts/${process.env.AVITO_USER_ID}/chats/${encodeURIComponent(chatId)}/messages/?${query}`
  );
}

// Отправка текстового сообщения в чат Авито
async function sendMessage(chatId, text) {
  const normalizedChatId = String(chatId || '').trim();
  const messageText = String(text || '').trim();

  if (!normalizedChatId) {
    throw new Error('Chat ID is required');
  }

  if (!messageText) {
    throw new Error('Message text is required');
  }

  if (messageText.length > 1000) {
    throw new Error('Message exceeds 1000 characters');
  }

  return avitoRequest(
    `/messenger/v1/accounts/${process.env.AVITO_USER_ID}/chats/${encodeURIComponent(normalizedChatId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        type: 'text',
        message: {
          text: messageText
        }
      })
    }
  );
}


// Загрузка изображения в Messenger API Авито.
async function uploadImage(buffer, filename, mimetype) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Empty image');
  if (buffer.length > 24 * 1024 * 1024) throw new Error('Image exceeds 24 MB');
  const form = new FormData();
  const blob = new Blob([buffer], { type: mimetype || 'application/octet-stream' });
  form.append('uploadfile[]', blob, filename || 'image');
  return avitoRequest(
    `/messenger/v1/accounts/${process.env.AVITO_USER_ID}/uploadImages`,
    { method: 'POST', body: form }
  );
}

async function sendImageMessage(chatId, imageId) {
  if (!chatId || !imageId) throw new Error('chatId and imageId are required');
  return avitoRequest(
    `/messenger/v1/accounts/${process.env.AVITO_USER_ID}/chats/${encodeURIComponent(chatId)}/messages/image`,
    { method: 'POST', body: JSON.stringify({ image_id: imageId }) }
  );
}

async function getVoiceFiles(voiceIds) {
  const ids = [...new Set((Array.isArray(voiceIds) ? voiceIds : [voiceIds]).map(x => String(x || '').trim()).filter(Boolean))];
  if (!ids.length || ids.length > 20) throw new Error('voice_ids must contain 1–20 IDs');
  const query = new URLSearchParams();
  ids.forEach(id => query.append('voice_ids', id));
  return avitoRequest(
    `/messenger/v1/accounts/${process.env.AVITO_USER_ID}/getVoiceFiles?${query.toString()}`
  );
}

module.exports = {
  getAccessToken,
  avitoRequest,
  getAccount,
  getChats,
  getMessages,
  sendMessage,
  uploadImage,
  sendImageMessage,
  getVoiceFiles
};

