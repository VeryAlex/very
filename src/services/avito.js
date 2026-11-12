
'use strict';

const API_URL = 'https://api.avito.ru';

let cachedToken = null;
let tokenExpiresAt = 0;

// Получение OAuth-токена
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const clientId = process.env.AVITO_CLIENT_ID;
  const clientSecret = process.env.AVITO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Не заданы API-ключи Avito');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });

  const response = await fetch(`${API_URL}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Avito OAuth error: HTTP ${response.status}`);
  }

  if (!data.access_token) {
    throw new Error('Avito не вернул access_token');
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;

  return cachedToken;
}

// Универсальный запрос к Avito API
async function avitoRequest(endpoint, options = {}) {
  const token = await getAccessToken();

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('AVITO API ERROR:', {
      status: response.status,
      endpoint,
      details: data
    });

    throw new Error(`Avito API error: HTTP ${response.status}`);
  }

  return data;
}

// Информация об основном аккаунте
async function getAccount() {
  return avitoRequest('/core/v1/accounts/self');
}

// Получение списка чатов
async function getChats(limit = 100, offset = 0, accountId = null) {
  const account = accountId ? { id: accountId } : await getAccount();

  if (!account.id) {
    throw new Error('Не удалось определить ID аккаунта Avito');
  }

  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset)
  });

  return avitoRequest(
    `/messenger/v2/accounts/${account.id}/chats?${params}`
  );
}

// Получение истории сообщений чата
async function getMessages(chatId, limit = 100, offset = 0, accountId = null) {
  const account = accountId ? { id: accountId } : await getAccount();

  if (!account.id) {
    throw new Error('Не удалось определить ID аккаунта Avito');
  }

  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset)
  });

  return avitoRequest(
    `/messenger/v3/accounts/${account.id}/chats/${encodeURIComponent(chatId)}/messages/?${params}`
  );
}


// Получение временных URL голосовых сообщений Avito
async function getVoiceFiles(voiceIds) {
  if (!Array.isArray(voiceIds) || !voiceIds.length) {
    return {};
  }

  const account = await getAccount();
  if (!account.id) throw new Error('Avito account ID отсутствует');

  const params = new URLSearchParams({
    voice_ids: voiceIds.join(',')
  });

  return avitoRequest(
    `/messenger/v1/accounts/${account.id}/getVoiceFiles?${params}`
  );
}

// Экспорт функций
module.exports = {
  getAccessToken,
  avitoRequest,
  getAccount,
  getChats,
  getMessages,
  getVoiceFiles
};
