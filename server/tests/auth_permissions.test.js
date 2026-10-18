const { api, as, makeWorld, makeItem, makeUser, uid, pool } = require('./helpers');

describe('authentication', () => {
  let w;
  beforeAll(async () => { w = await makeWorld(); });

  test('rejects requests without or with a bad token', async () => {
    expect((await api().get('/api/items')).status).toBe(401);
    expect((await api().get('/api/items').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  test('login works and wrong password / unknown email give the same error', async () => {
    const ok = await api().post('/api/auth/login').send({ email: w.member.email, password: 'Password123!' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.memberships[0]).toMatchObject({ role: 'member' });
    const bad = await api().post('/api/auth/login').send({ email: w.member.email, password: 'wrong-password' });
    const unknown = await api().post('/api/auth/login').send({ email: 'ghost@test.local', password: 'whatever1' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
  });

  test('duplicate email (case-insensitive) is rejected; short password is rejected', async () => {
    const dup = await api().post('/api/auth/register').send({ name: 'X Y', email: w.member.email.toUpperCase(), password: 'Password123!' });
    expect(dup.status).toBe(409);
    const weak = await api().post('/api/auth/register').send({ name: 'X Y', email: 'new@test.local', password: 'short' });
    expect(weak.status).toBe(400);
  });

  test('password hashes are never returned', async () => {
    const me = await as(w.member).get('/api/auth/me');
    expect(JSON.stringify(me.body)).not.toMatch(/password/i);
  });
});

describe('role-based authorization', () => {
  let w, item;
  beforeEach(async () => { w = await makeWorld(); item = await makeItem(w, w.member); });

  test('viewer can read but cannot create, comment, claim, edit or transition', async () => {
    expect((await as(w.viewer).get(`/api/items/${item.id}`)).status).toBe(200);
    expect((await as(w.viewer).get('/api/items')).body.total).toBe(1);
    expect((await as(w.viewer).post('/api/items', { teamId: w.team.id, title: 'Nope nope' })).status).toBe(403);
    expect((await as(w.viewer).post(`/api/items/${item.id}/comments`, { body: 'hi' })).status).toBe(403);
    expect((await as(w.viewer).post(`/api/items/${item.id}/claim`)).status).toBe(403);
    expect((await as(w.viewer).patch(`/api/items/${item.id}`, { version: 1, title: 'Hacked title' })).status).toBe(403);
    expect((await as(w.viewer).post(`/api/items/${item.id}/transition`, { to: 'in_progress' })).status).toBe(403);
  });

  test('non-members get 404 (existence not leaked) and see nothing in lists', async () => {
    expect((await as(w.outsider).get(`/api/items/${item.id}`)).status).toBe(404);
    expect((await as(w.outsider).get(`/api/items/${item.id}/activity`)).status).toBe(404);
    expect((await as(w.outsider).post(`/api/items/${item.id}/claim`)).status).toBe(404);
    expect((await as(w.outsider).post(`/api/items/${item.id}/comments`, { body: 'x' })).status).toBe(404);
    expect((await as(w.outsider).patch(`/api/items/${item.id}`, { version: 1, title: 'Hacked title' })).status).toBe(404);
    expect((await as(w.outsider).post('/api/items', { teamId: w.team.id, title: 'Sneaky item' })).status).toBe(404);
    expect((await as(w.outsider).get('/api/items')).body.total).toBe(0);
    expect((await as(w.outsider).get('/api/items').query({ teamId: w.team.id })).body.total).toBe(0);
    expect((await as(w.outsider).get(`/api/teams/${w.team.id}/members`)).status).toBe(404);
    expect((await as(w.outsider).get('/api/dashboard')).body.urgentUnassigned).toEqual([]);
  });

  test('malformed ids return 404, not a 500', async () => {
    expect((await as(w.member).get('/api/items/not-a-uuid')).status).toBe(404);
  });

  test('roles are per team: admin of team A has no power in team B', async () => {
    const other = await as(w.outsider).post('/api/teams', { name: 'Other Team' });
    const foreign = await as(w.outsider).post('/api/items', { teamId: other.body.team.id, title: 'Foreign item' });
    expect((await as(w.admin).get(`/api/items/${foreign.body.item.id}`)).status).toBe(404);
    expect((await as(w.admin).post(`/api/items/${foreign.body.item.id}/assign`, { version: 1, assigneeId: w.admin.id })).status).toBe(404);
  });

  test('member cannot edit an item they neither created nor hold; lead can', async () => {
    const r = await as(w.member2).patch(`/api/items/${item.id}`, { version: 1, priority: 'low' });
    expect(r.status).toBe(403);
    expect((await as(w.lead).patch(`/api/items/${item.id}`, { version: 1, priority: 'low' })).status).toBe(200);
  });

  test('member cannot assign others; lead can, and only to Member+ users', async () => {
    expect((await as(w.member).post(`/api/items/${item.id}/assign`, { version: 1, assigneeId: w.member2.id })).status).toBe(403);
    const toViewer = await as(w.lead).post(`/api/items/${item.id}/assign`, { version: 1, assigneeId: w.viewer.id });
    expect(toViewer.status).toBe(422);
    const toOutsider = await as(w.lead).post(`/api/items/${item.id}/assign`, { version: 1, assigneeId: w.outsider.id });
    expect(toOutsider.status).toBe(422);
    const ok = await as(w.lead).post(`/api/items/${item.id}/assign`, { version: 1, assigneeId: w.member2.id });
    expect(ok.status).toBe(200);
    expect(ok.body.item.assigneeId).toBe(w.member2.id);
  });

  test('member cannot assign at creation; lead can', async () => {
    const m = await as(w.member).post('/api/items', { teamId: w.team.id, title: 'Self assigned', assigneeId: w.member.id });
    expect(m.status).toBe(403);
    const l = await as(w.lead).post('/api/items', { teamId: w.team.id, title: 'Lead assigned', assigneeId: w.member.id });
    expect(l.status).toBe(201);
  });

  test('only admins manage members; privilege escalation attempts fail', async () => {
    const add = (u, who, role) => as(u).post(`/api/teams/${w.team.id}/members`, { email: who.email, role });
    expect((await add(w.lead, w.outsider, 'member')).status).toBe(403);
    expect((await as(w.member).patch(`/api/teams/${w.team.id}/members/${w.member.id}`, { role: 'admin' })).status).toBe(403);
    expect((await as(w.lead).patch(`/api/teams/${w.team.id}/members/${w.lead.id}`, { role: 'admin' })).status).toBe(403);
    expect((await as(w.member).del(`/api/teams/${w.team.id}/members/${w.member2.id}`)).status).toBe(403);
    expect((await add(w.admin, w.outsider, 'member')).status).toBe(201);
  });

  test('a team always keeps one admin (even under concurrent demotions)', async () => {
    const second = await as(w.admin).patch(`/api/teams/${w.team.id}/members/${w.lead.id}`, { role: 'admin' });
    expect(second.status).toBe(200);
    // two admins demote each other at the same moment: exactly one may succeed
    const [a, b] = await Promise.all([
      as(w.admin).patch(`/api/teams/${w.team.id}/members/${w.lead.id}`, { role: 'member' }),
      as(w.lead).patch(`/api/teams/${w.team.id}/members/${w.admin.id}`, { role: 'member' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    const { rows } = await pool.query(`SELECT count(*)::int n FROM memberships WHERE team_id=$1 AND role='admin'`, [w.team.id]);
    expect(rows[0].n).toBe(1);
  });

  test('role changes take effect immediately (token is not trusted for roles)', async () => {
    expect((await as(w.member2).post(`/api/items/${item.id}/comments`, { body: 'ok' })).status).toBe(201);
    await as(w.admin).patch(`/api/teams/${w.team.id}/members/${w.member2.id}`, { role: 'viewer' });
    expect((await as(w.member2).post(`/api/items/${item.id}/comments`, { body: 'again' })).status).toBe(403);
  });

  test('removing a member returns their active items to the pool and logs it', async () => {
    await as(w.member2).post(`/api/items/${item.id}/claim`);
    await as(w.member2).post(`/api/items/${item.id}/transition`, { to: 'in_progress' });
    await as(w.admin).del(`/api/teams/${w.team.id}/members/${w.member2.id}`);
    const r = await as(w.admin).get(`/api/items/${item.id}`);
    expect(r.body.item).toMatchObject({ assigneeId: null, status: 'open' });
    expect(r.body.activity.some((a) => /Unassigned automatically/.test(a.comment || ''))).toBe(true);
    expect((await as(w.member2).get(`/api/items/${item.id}`)).status).toBe(404);
  });

  test('input validation: bad enum, empty title, unknown fields, malformed JSON', async () => {
    expect((await as(w.member).post('/api/items', { teamId: w.team.id, title: 'ab' })).status).toBe(400);
    expect((await as(w.member).post('/api/items', { teamId: w.team.id, title: 'Valid title', priority: 'asap' })).status).toBe(400);
    expect((await as(w.lead).patch(`/api/items/${item.id}`, { version: 1, status: 'closed' })).status).toBe(400);
    const bad = await api().post('/api/items').set('Authorization', `Bearer ${w.member.token}`).set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
  });

  test('list filters never cross team boundaries', async () => {
    const other = await makeUser('solo');
    const t = await as(other).post('/api/teams', { name: 'Solo Team' });
    await as(other).post('/api/items', { teamId: t.body.team.id, title: 'Private to solo' });
    const mine = await as(w.member).get('/api/items').query({ q: 'Private' });
    expect(mine.body.total).toBe(0);
    const bySql = await as(w.member).get('/api/items').query({ q: '%' });
    expect(bySql.body.total).toBe(0); // wildcard is escaped, not treated as match-all
  });
});
