
'use strict';

const { Pool } = require('pg');
const { syncAvito } = require('../src/services/avito-sync');

const db = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  try {
    console.log('Запускаем импорт одного чата...');

    const result = await syncAvito(db, {
      maxChats: 1
    });

    console.log('РЕЗУЛЬТАТ ИМПОРТА:', result);

    const check = await db.query(`
      SELECT
        c.avito_chat_id,
        c.peer_name,
        c.item_title,
        COUNT(DISTINCT p.id) AS participants,
        COUNT(DISTINCT m.id) AS messages
      FROM chats c
      LEFT JOIN chat_participants p ON p.chat_id = c.id
      LEFT JOIN messages m ON m.chat_id = c.id
      WHERE c.avito_chat_id = (
        SELECT avito_chat_id
        FROM chats
        ORDER BY created_at DESC
        LIMIT 1
      )
      GROUP BY c.id
    `);

    console.log('ПРОВЕРКА БАЗЫ:', check.rows);

  } catch (error) {
    console.error('SYNC ERROR:', error.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main();
