
'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Pool } = require('pg');

const scrypt = promisify(crypto.scrypt);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function main() {
  const password = process.env.NEW_PASSWORD;

  if (!password || password.length < 8) {
    throw new Error('Пароль должен содержать минимум 8 символов');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  const passwordHash = `scrypt$${salt}$${hash.toString('hex')}`;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE users
      SET password_hash = $1, updated_at = now()
      WHERE email = $2 AND role = 'admin'
      RETURNING id, email
    `, [passwordHash, 'aleshka.klimovich@gmail.com']);

    if (result.rowCount !== 1) {
      throw new Error('Администратор не найден');
    }

    await client.query(
      'DELETE FROM auth_sessions WHERE user_id = $1',
      [result.rows[0].id]
    );

    await client.query('COMMIT');

    console.log('Пароль успешно обновлён.');
    console.log('Администратор:', result.rows[0].email);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch(error => {
    console.error('Ошибка:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
