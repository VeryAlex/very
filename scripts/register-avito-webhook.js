'use strict';

const { getAccessToken } = require('../src/services/avito');

async function main() {
  const secret = process.env.AVITO_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error('AVITO_WEBHOOK_SECRET отсутствует');
  }

  const url =
    `https://crm.very-delivery.ru/api/avito/webhook/${encodeURIComponent(secret)}`;

  const token = await getAccessToken();

  const response = await fetch(
    'https://api.avito.ru/messenger/v3/webhook',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url })
    }
  );

  const result = await response.text();

  console.log('HTTP STATUS:', response.status);
  console.log('AVITO RESPONSE:', result);

  if (!response.ok) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('REGISTRATION ERROR:', error.message);
  process.exitCode = 1;
});
