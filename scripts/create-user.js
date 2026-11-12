'use strict';

// Usage: USER_EMAIL=a@b.c USER_PASSWORD=... [USER_NAME=..] [USER_ROLE=admin|manager] node scripts/create-user.js
// Creates the user, or resets password/role if the email already exists.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Pool } = require('pg');

const scrypt = promisify(crypto.scrypt);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const email = (process.env.USER_EMAIL || '').trim().toLowerCase();
  const password = process.env.USER_PASSWORD || '';
  const role = process.env.USER_ROLE || 'admin';
  const name = process.env.USER_NAME || email.split('@')[0];

  if (!email.includes('@')) throw new Error('USER_EMAIL is required');
  if (password.length < 8) throw new Error('USER_PASSWORD must be at least 8 characters');
  if (!['admin', 'manager'].includes(role)) throw new Error('USER_ROLE must be admin or manager');

  // Same format as hashPassword() in src/auth.js
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  const passwordHash = `scrypt$${salt}$${hash.toString('hex')}`;

  const { rows } = await pool.query(`
    INSERT INTO users (email, display_name, role, password_hash)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
          is_active = TRUE, updated_at = now()
    RETURNING id, email, role
  `, [email, name, role, passwordHash]);

  console.log('User ready:', rows[0]);
}

main()
  .catch(error => {
    console.error('Error:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
