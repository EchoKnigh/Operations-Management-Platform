// Minimal migration runner: applies migrations/*.sql in order, once each, inside a transaction.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate(databaseUrl = process.env.DATABASE_URL) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    // Advisory lock so two instances booting at once don't race on migrations.
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (applied.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log(`applied ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    await client.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    client.release();
    await pool.end();
  }
}

module.exports = migrate;

if (require.main === module) {
  migrate().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
