const { as, makeWorld, makeItem, makeUser, uid, pool } = require('./helpers');

const count = async (sql, args) => (await pool.query(sql, args)).rows[0].n;

describe('concurrent claims', () => {
  test('20 simultaneous claims on one item: exactly one winner, 19 conflicts, one history row', async () => {
    const w = await makeWorld();
    // 20 distinct members so each claim is a different user racing for the same item
    const racers = await Promise.all(Array.from({ length: 20 }, (_, i) => makeUser(`racer${i}`)));
    for (const r of racers) await as(w.admin).post(`/api/teams/${w.team.id}/members`, { email: r.email, role: 'member' });
    const item = await makeItem(w, w.lead, { priority: 'urgent' });

    const results = await Promise.all(racers.map((r) => as(r).post(`/api/items/${item.id}/claim`)));
    const ok = results.filter((r) => r.status === 200);
    const conflict = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(19);
    expect(conflict.every((r) => r.body.error.code === 'ALREADY_ASSIGNED')).toBe(true);

    const winner = racers[results.indexOf(ok[0])];
    const row = (await pool.query('SELECT assignee_id, version FROM work_items WHERE id = $1', [item.id])).rows[0];
    expect(row.assignee_id).toBe(winner.id);
    expect(row.version).toBe(2); // exactly one state change
    expect(await count(`SELECT count(*)::int n FROM activity WHERE work_item_id=$1 AND action='assignee_changed'`, [item.id])).toBe(1);
  });

  test('the same user double-clicking Claim: one succeeds, the other gets a clean 409', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    const rs = await Promise.all([1, 2, 3].map(() => as(w.member).post(`/api/items/${item.id}/claim`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
  });

  test('a lead assigning while a member claims: one outcome wins, no lost update', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.lead);
    const [claim, assign] = await Promise.all([
      as(w.member).post(`/api/items/${item.id}/claim`),
      as(w.lead).post(`/api/items/${item.id}/assign`, { version: 1, assigneeId: w.member2.id }),
    ]);
    // Whichever committed first wins; the loser must be told (409), never silently overwrite.
    expect([claim.status, assign.status].sort()).toEqual([200, 409]);
    const row = (await pool.query('SELECT assignee_id, version FROM work_items WHERE id=$1', [item.id])).rows[0];
    expect(row.version).toBe(2);
    expect(row.assignee_id).toBe(claim.status === 200 ? w.member.id : w.member2.id);
  });
});

describe('optimistic locking on updates', () => {
  test('two leads edit from the same version: one wins, the other gets VERSION_CONFLICT with current state', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    const [a, b] = await Promise.all([
      as(w.lead).patch(`/api/items/${item.id}`, { version: 1, priority: 'urgent' }),
      as(w.lead2).patch(`/api/items/${item.id}`, { version: 1, priority: 'low' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('VERSION_CONFLICT');
    expect(loser.body.error.details.current.version).toBe(2);
    expect(await count(`SELECT count(*)::int n FROM activity WHERE work_item_id=$1 AND action='priority_changed'`, [item.id])).toBe(1);
  });

  test('stale version is rejected after the item changed', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    await as(w.lead).patch(`/api/items/${item.id}`, { version: 1, priority: 'low' });
    const stale = await as(w.member).patch(`/api/items/${item.id}`, { version: 1, title: 'Overwrite attempt' });
    expect(stale.status).toBe(409);
    expect((await as(w.member).get(`/api/items/${item.id}`)).body.item.title).toBe('Payment gateway timeout');
  });

  test('transition with a stale version is rejected', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    await as(w.member).post(`/api/items/${item.id}/claim`);
    const r = await as(w.member).post(`/api/items/${item.id}/transition`, { to: 'in_progress', version: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('VERSION_CONFLICT');
  });

  test('two leads approve the same item at once: one approval, one history row', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    await as(w.member).post(`/api/items/${item.id}/claim`);
    await as(w.member).post(`/api/items/${item.id}/transition`, { to: 'in_progress' });
    await as(w.member).post(`/api/items/${item.id}/transition`, { to: 'awaiting_approval' });
    const [a, b] = await Promise.all([
      as(w.lead).post(`/api/items/${item.id}/transition`, { to: 'resolved' }),
      as(w.lead2).post(`/api/items/${item.id}/transition`, { to: 'resolved' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await count(`SELECT count(*)::int n FROM activity WHERE work_item_id=$1 AND new_value='resolved'`, [item.id])).toBe(1);
  });

  test('approve racing with reject: the two are serialised and history forms an unbroken chain', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    await as(w.member).post(`/api/items/${item.id}/claim`);
    await as(w.member).post(`/api/items/${item.id}/transition`, { to: 'in_progress' });
    await as(w.member).post(`/api/items/${item.id}/transition`, { to: 'awaiting_approval' });
    const [approve, reject] = await Promise.all([
      as(w.lead).post(`/api/items/${item.id}/transition`, { to: 'resolved' }),
      as(w.lead2).post(`/api/items/${item.id}/transition`, { to: 'in_progress', comment: 'Needs more work' }),
    ]);
    // Either order is a legal serialisation (approve->reopen both succeed, or reject->approve is invalid).
    // What must never happen is both failing, or a state the history cannot explain.
    expect([approve.status, reject.status]).toContain(200);
    const hist = (await pool.query(
      `SELECT old_value, new_value FROM activity WHERE work_item_id=$1 AND action='status_changed' ORDER BY id`, [item.id]
    )).rows;
    let prev = 'open';
    for (const h of hist) { expect(h.old_value).toBe(prev); prev = h.new_value; }
    const status = (await pool.query('SELECT status FROM work_items WHERE id=$1', [item.id])).rows[0].status;
    expect(status).toBe(prev);
  });

  test('many parallel comments all land (comments never conflict)', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => as(w.member).post(`/api/items/${item.id}/comments`, { body: `note ${i}` })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await count(`SELECT count(*)::int n FROM activity WHERE work_item_id=$1 AND action='comment_added'`, [item.id])).toBe(15);
  });
});

describe('idempotency', () => {
  test('retrying a create with the same key returns the same item and creates one row', async () => {
    const w = await makeWorld();
    const key = uid();
    const body = { teamId: w.team.id, title: 'Refund stuck for 3 days', type: 'payment' };
    const first = await as(w.member).post('/api/items', body, key);
    const second = await as(w.member).post('/api/items', body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.item.id).toBe(first.body.item.id);
    expect(await count('SELECT count(*)::int n FROM work_items')).toBe(1);
    expect(await count('SELECT count(*)::int n FROM activity')).toBe(1);
  });

  test('10 simultaneous identical requests (double-submit storm) create exactly one item', async () => {
    const w = await makeWorld();
    const key = uid();
    const body = { teamId: w.team.id, title: 'Duplicate me once' };
    const rs = await Promise.all(Array.from({ length: 10 }, () => as(w.member).post('/api/items', body, key)));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.item.id)).size).toBe(1);
    expect(await count('SELECT count(*)::int n FROM work_items')).toBe(1);
  });

  test('without a key, two creates make two items (key is opt-in per request)', async () => {
    const w = await makeWorld();
    const body = { teamId: w.team.id, title: 'No key given' };
    await as(w.member).post('/api/items', body);
    await as(w.member).post('/api/items', body);
    expect(await count('SELECT count(*)::int n FROM work_items')).toBe(2);
  });

  test('same key with a different payload is rejected, not silently replayed', async () => {
    const w = await makeWorld();
    const key = uid();
    await as(w.member).post('/api/items', { teamId: w.team.id, title: 'First payload' }, key);
    const r = await as(w.member).post('/api/items', { teamId: w.team.id, title: 'Second payload' }, key);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await count('SELECT count(*)::int n FROM work_items')).toBe(1);
  });

  test('keys are scoped per user: another user reusing the key gets their own result', async () => {
    const w = await makeWorld();
    const key = uid();
    const body = { teamId: w.team.id, title: 'Shared key text' };
    const a = await as(w.member).post('/api/items', body, key);
    const b = await as(w.member2).post('/api/items', body, key);
    expect(a.body.item.id).not.toBe(b.body.item.id);
  });

  test('a failed request does not burn the key: it can be retried after the cause is fixed', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    const key = uid();
    // 1) invalid (item is unassigned) -> 422, key rolled back
    const bad = await as(w.lead).post(`/api/items/${item.id}/transition`, { to: 'in_progress' }, key);
    expect(bad.status).toBe(422);
    expect(await count('SELECT count(*)::int n FROM idempotency_keys')).toBe(0);
    // 2) same key + same payload succeeds after claiming
    await as(w.member).post(`/api/items/${item.id}/claim`);
    const good = await as(w.lead).post(`/api/items/${item.id}/transition`, { to: 'in_progress' }, key);
    expect(good.status).toBe(200);
  });

  test('retrying a transition with the same key replays success instead of "invalid transition"', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    await as(w.member).post(`/api/items/${item.id}/claim`);
    const key = uid();
    const a = await as(w.member).post(`/api/items/${item.id}/transition`, { to: 'in_progress' }, key);
    const b = await as(w.member).post(`/api/items/${item.id}/transition`, { to: 'in_progress' }, key);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(await count(`SELECT count(*)::int n FROM activity WHERE work_item_id=$1 AND action='status_changed'`, [item.id])).toBe(1);
    // ...whereas the same request WITHOUT a key is correctly refused the second time
    const c = await as(w.member).post(`/api/items/${item.id}/transition`, { to: 'in_progress' });
    expect(c.status).toBe(409);
  });

  test('duplicate comment submissions with one key post one comment', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    const key = uid();
    await Promise.all([1, 2, 3, 4].map(() => as(w.member).post(`/api/items/${item.id}/comments`, { body: 'Only once' }, key)));
    expect(await count(`SELECT count(*)::int n FROM activity WHERE work_item_id=$1 AND action='comment_added'`, [item.id])).toBe(1);
  });

  test('malformed key is rejected', async () => {
    const w = await makeWorld();
    const r = await as(w.member).post('/api/items', { teamId: w.team.id, title: 'Whatever' }, 'short');
    expect(r.status).toBe(400);
  });
});
