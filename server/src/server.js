const config = require('./config');
const migrate = require('../scripts/migrate');
const { createApp } = require('./app');
const { pool, query } = require('./db');

// Idempotency keys only need to outlive realistic client retries; drop them after 24h.
async function purgeIdempotencyKeys() {
  try {
    await query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  } catch (e) {
    console.error('idempotency purge failed:', e.message);
  }
}

async function main() {
  await migrate(config.databaseUrl); // idempotent; safe on every boot
  await purgeIdempotencyKeys();
  setInterval(purgeIdempotencyKeys, 60 * 60 * 1000).unref();
  const server = createApp().listen(config.port, () => console.log(`API listening on :${config.port}`));
  const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
