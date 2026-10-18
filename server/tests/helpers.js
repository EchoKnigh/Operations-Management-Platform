const request = require('supertest');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

const app = createApp();
const api = () => request(app);
const uid = () => crypto.randomUUID();

async function resetDb() {
  await pool.query('TRUNCATE users, teams, memberships, work_items, activity, idempotency_keys CASCADE');
}

let n = 0;
async function makeUser(label) {
  n += 1;
  const email = `${label}${n}@test.local`;
  const res = await api().post('/api/auth/register').send({ name: `${label} ${n}`, email, password: 'Password123!' });
  if (res.status !== 201) throw new Error('register failed ' + JSON.stringify(res.body));
  return { id: res.body.user.id, email, name: res.body.user.name, token: res.body.token };
}

const as = (u) => ({
  get: (p) => api().get(p).set('Authorization', `Bearer ${u.token}`),
  post: (p, body, key) => {
    const r = api().post(p).set('Authorization', `Bearer ${u.token}`);
    if (key) r.set('Idempotency-Key', key);
    return r.send(body ?? {});
  },
  patch: (p, body) => api().patch(p).set('Authorization', `Bearer ${u.token}`).send(body),
  del: (p) => api().delete(p).set('Authorization', `Bearer ${u.token}`),
});

/** One team with a user for every role (+ a second member and an outsider in no team). */
async function makeWorld() {
  await resetDb();
  const [admin, lead, lead2, member, member2, viewer, outsider] = await Promise.all(
    ['admin', 'lead', 'lead2', 'member', 'member2', 'viewer', 'outsider'].map(makeUser)
  );
  const t = await as(admin).post('/api/teams', { name: 'Payments Ops' });
  const team = t.body.team;
  for (const [u, role] of [[lead, 'lead'], [lead2, 'lead'], [member, 'member'], [member2, 'member'], [viewer, 'viewer']]) {
    const r = await as(admin).post(`/api/teams/${team.id}/members`, { email: u.email, role });
    if (r.status !== 201) throw new Error('add member failed ' + JSON.stringify(r.body));
  }
  return { team, admin, lead, lead2, member, member2, viewer, outsider };
}

async function makeItem(w, by, extra = {}) {
  const r = await as(by || w.member).post('/api/items', {
    teamId: w.team.id, title: 'Payment gateway timeout', type: 'incident', priority: 'high', ...extra,
  });
  if (r.status !== 201) throw new Error('create item failed ' + JSON.stringify(r.body));
  return r.body.item;
}

module.exports = { api, as, uid, resetDb, makeUser, makeWorld, makeItem, pool };
