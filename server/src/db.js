const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (e) => console.error('Unexpected pg pool error', e));

/**
 * Run `fn(client)` inside a transaction (READ COMMITTED). Commits on success,
 * rolls back on any thrown error. All state-changing endpoints go through this so
 * the change and its activity-log rows are atomic.
 */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* connection already broken */
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, tx, query: (...a) => pool.query(...a) };
