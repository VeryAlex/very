
'use strict';

const bcrypt = require('bcryptjs');
const { pool } = require('./db');

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      return reject(new Error('Нужен интерактивный терминал'));
    }

    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let value = '';

    function cleanup() {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    }

    function onData(char) {
      if (char === '\u0003') {
        cleanup();
        reject(new Error('Отменено'));
        return;
      }

      if (char === '\r' || char === '\n') {
        cleanup();
        resolve(value);
        return;
      }

      if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1);
        return;
      }

      if (char >= ' ') {
        value += char;
      }
    }

    process.stdin.on('data', onData);
  });
}

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  const displayName = process.argv[3] || '';
  const role = process.argv[4] || '';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Укажи корректный email');
  }

  if (!displayName || !['admin', 'manager'].includes(role)) {
    throw new Error(
      'Использование: node src/create-user.js email "Имя" admin|manager'
    );
  }

  const existing = await pool.query(
    'SELECT email FROM crm_users WHERE email = $1',
    [email]
  );

  if (existing.rows.length) {
    throw new Error('Пользователь уже существует. Создание отменено.');
  }

  const password = await readHidden('Введите пароль (минимум 12 символов): ');

  if (password.length < 12) {
    throw new Error('Пароль должен содержать минимум 12 символов');
  }

  const confirmation = await readHidden('Повторите пароль: ');

  if (password !== confirmation) {
    throw new Error('Пароли не совпадают');
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await pool.query(
    `INSERT INTO crm_users
      (email, display_name, role, password_hash)
     VALUES ($1, $2, $3, $4)`,
    [email, displayName, role, passwordHash]
  );

  console.log('\nПользователь успешно создан!');
  console.log('Email:', email);
  console.log('Имя:', displayName);
  console.log('Роль:', role);
  console.log('Пароль сохранён в виде bcrypt-хеша.');
}

main()
  .catch(error => {
    console.error('\nОшибка:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
