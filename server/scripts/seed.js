// Demo data: 5 users (all with password "Password123!"), 2 teams, ~14 work items in every state.
// Safe to run repeatedly: it does nothing if the demo admin already exists.
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const migrate = require('./migrate');
const config = require('../src/config');
const { pool, tx } = require('../src/db');

const PASSWORD = 'Password123!';

async function seed() {
  await migrate(config.databaseUrl);
  const exists = await pool.query(`SELECT 1 FROM users WHERE email = 'admin@demo.com'`);
  if (exists.rowCount) {
    console.log('Demo data already present - nothing to do.');
    return;
  }
  const hash = await bcrypt.hash(PASSWORD, 10);

  await tx(async (c) => {
    const user = async (name, email) =>
      (await c.query('INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id', [name, email, hash])).rows[0].id;
    const U = {
      admin: await user('Ada Admin', 'admin@demo.com'),
      lead: await user('Leo Lead', 'lead@demo.com'),
      alice: await user('Alice Member', 'alice@demo.com'),
      bob: await user('Bob Member', 'bob@demo.com'),
      viewer: await user('Vera Viewer', 'viewer@demo.com'),
    };
    const team = async (name) => (await c.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
    const T = { pay: await team('Payments Ops'), sup: await team('Customer Support') };
    const member = (u, t, role) => c.query('INSERT INTO memberships (user_id, team_id, role) VALUES ($1,$2,$3)', [U[u], T[t], role]);
    for (const t of ['pay', 'sup']) {
      await member('admin', t, 'admin');
      await member('lead', t, 'lead');
      await member('alice', t, 'member');
      await member('viewer', t, 'viewer');
    }
    await member('bob', 'pay', 'member');

    const log = (id, actor, action, extra = {}) =>
      c.query(
        `INSERT INTO activity (work_item_id, actor_id, action, field, old_value, new_value, comment, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' minutes')::interval)`,
        [id, U[actor], action, extra.field || null, extra.from || null, extra.to || null, extra.comment || null, String(extra.ago ?? 0)]
      );

    // [team, title, type, priority, status, creator, assignee, description]
    const items = [
      ['pay', 'Card payments failing with gateway timeout', 'incident', 'urgent', 'open', 'lead', null, 'Spike of 504s from the acquirer since 09:40. Checkout conversion is down.'],
      ['pay', 'Settlement file missing for yesterday', 'payment', 'urgent', 'open', 'alice', null, 'Bank SFTP drop is empty. Finance needs it before 14:00.'],
      ['pay', 'Double charge reported by enterprise customer', 'payment', 'high', 'in_progress', 'lead', 'alice', 'Customer was charged twice for invoice INV-2291.'],
      ['pay', 'Refund stuck in pending for 3 days', 'payment', 'high', 'awaiting_approval', 'bob', 'bob', 'Refund of 240.00 needs sign-off from a lead.'],
      ['pay', 'Quarterly PCI evidence collection', 'compliance', 'medium', 'in_progress', 'admin', 'bob', 'Collect and upload evidence for requirements 3 and 8.'],
      ['pay', 'Update chargeback response template', 'other', 'low', 'resolved', 'alice', 'alice', 'New wording agreed with legal.'],
      ['pay', 'Fix typo in merchant onboarding email', 'other', 'low', 'closed', 'bob', 'bob', ''],
      ['sup', 'Customer cannot reset password', 'customer_issue', 'high', 'open', 'alice', null, 'Reset emails are not arriving for gmail addresses.'],
      ['sup', 'Data-deletion request (GDPR) from EU customer', 'compliance', 'urgent', 'open', 'lead', null, 'Must be completed within 30 days of receipt.'],
      ['sup', 'Escalation: VIP customer outage', 'incident', 'urgent', 'in_progress', 'lead', 'lead', 'Customer reports API 500s for the last hour.'],
      ['sup', 'Review macro responses for refunds', 'other', 'medium', 'awaiting_approval', 'alice', 'alice', 'Updated six canned responses.'],
      ['sup', 'Invoice address change request', 'customer_issue', 'low', 'in_progress', 'alice', 'alice', ''],
      ['sup', 'Audit log export for compliance review', 'compliance', 'medium', 'resolved', 'admin', 'alice', ''],
      ['sup', 'Outdated help-centre article on chargebacks', 'other', 'low', 'open', 'viewer', null, ''],
    ];
    // the viewer cannot create items in-app; seed it under a member so the data stays consistent
    let ago = 600;
    for (const [t, title, type, priority, status, creator, assignee, description] of items) {
      const creatorKey = creator === 'viewer' ? 'alice' : creator;
      const id = (
        await c.query(
          `INSERT INTO work_items (team_id, title, description, type, priority, status, assignee_id, creator_id, version, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, 1, now() - ($9 || ' minutes')::interval, now() - ($9 || ' minutes')::interval) RETURNING id`,
          [T[t], title, description, type, priority, status, assignee ? U[assignee] : null, U[creatorKey], String(ago)]
        )
      ).rows[0].id;
      await log(id, creatorKey, 'created', { to: title, ago });
      if (assignee) await log(id, 'lead', 'assignee_changed', { field: 'assignee', to: U[assignee], ago: ago - 5 });
      const path = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];
      for (let i = 1; i <= path.indexOf(status); i++) {
        const actor = path[i] === 'resolved' || path[i] === 'closed' ? 'lead' : assignee || 'lead';
        await log(id, actor, 'status_changed', { field: 'status', from: path[i - 1], to: path[i], ago: ago - 10 - i * 7 });
      }
      if (status === 'in_progress') await log(id, assignee, 'comment_added', { comment: 'Picked this up, starting investigation.', ago: ago - 30 });
      ago = Math.max(5, ago - 40);
    }
  });
  console.log('Seeded. Log in with admin@demo.com / lead@demo.com / alice@demo.com / bob@demo.com / viewer@demo.com');
  console.log(`Password for all demo users: ${PASSWORD}`);
}

seed()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
