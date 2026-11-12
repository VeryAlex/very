'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('./db');

async function migrate() {
  const migrations = [
    '001_initial.sql',
    '002_auth.sql',
    '003_chat_sync.sql',
    '004_crm_features.sql'
  ];

  const client = await pool.connect();

  try {
    for (const filename of migrations) {
      const filepath = path.join(
        __dirname,
        '..',
        'sql',
        filename
      );

      if (!fs.existsSync(filepath)) {
        throw new Error(
          `Migration file not found: ${filename}`
        );
      }

      const sql = fs.readFileSync(filepath, 'utf8');

      console.log(`MIGRATION_START: ${filename}`);

      await client.query('BEGIN');

      try {
        await client.query(sql);
        await client.query('COMMIT');

        console.log(`MIGRATION_OK: ${filename}`);

      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    console.log('ALL_MIGRATIONS_OK');

  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('MIGRATION_FAILED:', error);
  process.exitCode = 1;
});
