'use strict';

const { getAccessToken } = require('./avito');

const API_URL = 'https://api.avito.ru';

async function uploadImage(accountId, buffer, filename, mimeType) {
  const token = await getAccessToken();

  const form = new FormData();

  form.append(
    'uploadfile[]',
    new Blob([buffer], { type: mimeType }),
    filename
  );

  const response = await fetch(
    `${API_URL}/messenger/v1/accounts/${accountId}/uploadImages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      body: form
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Ошибка загрузки фотографии в Avito: HTTP ${response.status}`);
  }

  const imageId = Object.keys(data)[0];

  if (!imageId) {
    throw new Error('Avito не вернул ID изображения');
  }

  return imageId;
}

async function sendImage(accountId, chatId, imageId) {
  const token = await getAccessToken();

  const response = await fetch(
    `${API_URL}/messenger/v1/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages/image`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ image_id: imageId })
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Ошибка отправки фотографии: HTTP ${response.status}`);
  }

  return data;
}

module.exports = {
  uploadImage,
  sendImage
};
