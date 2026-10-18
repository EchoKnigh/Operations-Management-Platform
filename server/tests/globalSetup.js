// Recreate the schema from scratch so every test run starts from the real migrations.
const { Client } = require('pg');
const migrate = require('../scripts/migrate');

module.exports = async () => {
  const url =
    process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/newtonite_test';
  if (!/test/i.test(url)) throw new Error('Refusing to wipe a database whose name does not contain "test"');
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(url);
};
