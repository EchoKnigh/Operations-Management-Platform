const { as, makeWorld, makeItem, pool } = require('./helpers');

const go = (u, id, to, extra = {}) => as(u).post(`/api/items/${id}/transition`, { to, ...extra });

describe('status workflow', () => {
  let w, item;
  beforeEach(async () => {
    w = await makeWorld();
    item = await makeItem(w, w.member);
  });

  test('happy path: Open → In Progress → Awaiting Approval → Resolved → Closed', async () => {
    expect((await as(w.member).post(`/api/items/${item.id}/claim`)).status).toBe(200);
    expect((await go(w.member, item.id, 'in_progress')).body.item.status).toBe('in_progress');
    expect((await go(w.member, item.id, 'awaiting_approval')).body.item.status).toBe('awaiting_approval');
    expect((await go(w.lead, item.id, 'resolved')).body.item.status).toBe('resolved');
    expect((await go(w.lead, item.id, 'closed')).body.item.status).toBe('closed');
  });

  test('steps cannot be skipped', async () => {
    await as(w.member).post(`/api/items/${item.id}/claim`);
    for (const to of ['awaiting_approval', 'resolved', 'closed']) {
      const r = await go(w.lead, item.id, to);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('INVALID_TRANSITION');
    }
    expect((await as(w.lead).get(`/api/items/${item.id}`)).body.item.status).toBe('open');
  });

  test('cannot start work on an unassigned item', async () => {
    const r = await go(w.lead, item.id, 'in_progress');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ASSIGNEE_REQUIRED');
  });

  test('a member can only move items assigned to them', async () => {
    await as(w.member).post(`/api/items/${item.id}/claim`);
    expect((await go(w.member2, item.id, 'in_progress')).status).toBe(403);
    expect((await go(w.lead, item.id, 'in_progress')).status).toBe(200); // leads may
  });

  async function toAwaiting() {
    await as(w.member).post(`/api/items/${item.id}/claim`);
    await go(w.member, item.id, 'in_progress');
    await go(w.member, item.id, 'awaiting_approval');
  }

  test('approval requires Lead+; members and viewers cannot approve', async () => {
    await toAwaiting();
    expect((await go(w.member, item.id, 'resolved')).status).toBe(403);
    expect((await go(w.member2, item.id, 'resolved')).status).toBe(403);
    expect((await go(w.viewer, item.id, 'resolved')).status).toBe(403);
    expect((await go(w.lead, item.id, 'resolved')).status).toBe(200);
  });

  test('four-eyes: a lead cannot approve their own work, an admin can', async () => {
    await as(w.lead).post(`/api/items/${item.id}/claim`);
    await go(w.lead, item.id, 'in_progress');
    await go(w.lead, item.id, 'awaiting_approval');
    const self = await go(w.lead, item.id, 'resolved');
    expect(self.status).toBe(403);
    expect(self.body.error.message).toMatch(/cannot approve/);
    expect((await go(w.lead2, item.id, 'resolved')).status).toBe(200);
  });

  test('rejecting or reopening needs a reason and goes back to In Progress', async () => {
    await toAwaiting();
    const noReason = await go(w.lead, item.id, 'in_progress');
    expect(noReason.status).toBe(422);
    const rej = await go(w.lead, item.id, 'in_progress', { comment: 'Missing evidence' });
    expect(rej.body.item.status).toBe('in_progress');
    await go(w.member, item.id, 'awaiting_approval');
    await go(w.lead, item.id, 'resolved');
    expect((await go(w.lead, item.id, 'in_progress')).status).toBe(422);
    expect((await go(w.lead, item.id, 'in_progress', { comment: 'Regression' })).status).toBe(200);
  });

  test('closed is terminal: no transitions, no edits, no assignment, no claim', async () => {
    await toAwaiting();
    await go(w.lead, item.id, 'resolved');
    const closed = (await go(w.lead, item.id, 'closed')).body.item;
    for (const to of ['open', 'in_progress', 'awaiting_approval', 'resolved']) {
      expect((await go(w.admin, item.id, to, { comment: 'x' })).status).toBe(409);
    }
    expect((await as(w.admin).patch(`/api/items/${item.id}`, { version: closed.version, title: 'Edited after close' })).status).toBe(409);
    expect((await as(w.admin).post(`/api/items/${item.id}/assign`, { version: closed.version, assigneeId: w.member2.id })).status).toBe(409);
    // comments are still allowed on closed items (post-mortem notes)
    expect((await as(w.member).post(`/api/items/${item.id}/comments`, { body: 'Post-mortem link' })).status).toBe(201);
  });

  test('unknown status value is a validation error', async () => {
    expect((await go(w.lead, item.id, 'done')).status).toBe(400);
  });

  test('the database itself refuses an In Progress item with no assignee', async () => {
    await expect(
      pool.query(`UPDATE work_items SET status = 'in_progress', assignee_id = NULL WHERE id = $1`, [item.id])
    ).rejects.toThrow(/active_items_have_assignee/);
  });

  test('capabilities returned to the UI match what the server enforces', async () => {
    await toAwaiting();
    const asMember = (await as(w.member).get(`/api/items/${item.id}`)).body.item.capabilities;
    expect(asMember.transitions).toEqual([]);
    const asLead2 = (await as(w.lead2).get(`/api/items/${item.id}`)).body.item.capabilities;
    expect(asLead2.transitions.sort()).toEqual(['in_progress', 'resolved']);
    const asViewer = (await as(w.viewer).get(`/api/items/${item.id}`)).body.item.capabilities;
    expect(asViewer).toMatchObject({ canEdit: false, canComment: false, canClaim: false, transitions: [] });
  });
});

describe('activity history', () => {
  let w, item;
  beforeEach(async () => {
    w = await makeWorld();
    item = await makeItem(w, w.member);
  });

  test('records creation, assignee, priority, status and comments with actor + old/new values', async () => {
    await as(w.lead).post(`/api/items/${item.id}/assign`, { version: 1, assigneeId: w.member2.id });
    await as(w.lead).patch(`/api/items/${item.id}`, { version: 2, priority: 'urgent', title: 'Gateway down (updated)' });
    await go(w.member2, item.id, 'in_progress');
    await as(w.member2).post(`/api/items/${item.id}/comments`, { body: 'Investigating logs' });

    const { activity } = (await as(w.viewer).get(`/api/items/${item.id}`)).body;
    const asc = [...activity].reverse();
    expect(asc.map((a) => a.action)).toEqual([
      'created', 'assignee_changed', 'field_updated', 'priority_changed', 'status_changed', 'comment_added',
    ]);
    expect(asc[1]).toMatchObject({ oldValue: null, newValue: w.member2.id, actorName: w.lead.name });
    expect(asc[3]).toMatchObject({ field: 'priority', oldValue: 'high', newValue: 'urgent' });
    expect(asc[4]).toMatchObject({ field: 'status', oldValue: 'open', newValue: 'in_progress', actorId: w.member2.id });
    expect(asc[5]).toMatchObject({ comment: 'Investigating logs' });
    expect(asc.every((a) => a.createdAt)).toBe(true);
  });

  test('failed or rejected actions leave no history behind', async () => {
    const before = (await pool.query('SELECT count(*)::int n FROM activity')).rows[0].n;
    await go(w.lead, item.id, 'resolved');                                     // invalid transition
    await as(w.viewer).post(`/api/items/${item.id}/comments`, { body: 'x' }); // forbidden
    await as(w.lead).patch(`/api/items/${item.id}`, { version: 99, priority: 'low' }); // stale version
    const after = (await pool.query('SELECT count(*)::int n FROM activity')).rows[0].n;
    expect(after).toBe(before);
  });

  test('no-op edits do not bump the version or write history', async () => {
    const r = await as(w.lead).patch(`/api/items/${item.id}`, { version: 1, priority: 'high' });
    expect(r.body.item.version).toBe(1);
    const { activity } = (await as(w.lead).get(`/api/items/${item.id}`)).body;
    expect(activity).toHaveLength(1);
  });

  test('history is append-only at the database level', async () => {
    await expect(pool.query(`UPDATE activity SET comment = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM activity`)).rejects.toThrow(/append-only/);
  });

  test('comment validation: empty and over-long comments rejected', async () => {
    expect((await as(w.member).post(`/api/items/${item.id}/comments`, { body: '   ' })).status).toBe(400);
    expect((await as(w.member).post(`/api/items/${item.id}/comments`, { body: 'x'.repeat(2001) })).status).toBe(400);
  });
});

describe('releasing a claim', () => {
  test('a member can hand back their own open claim, but not someone else\'s or an active one', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    await as(w.member).post(`/api/items/${item.id}/claim`);
    const caps = (await as(w.member).get(`/api/items/${item.id}`)).body.item.capabilities;
    expect(caps.canRelease).toBe(true);
    // another member cannot release it
    expect((await as(w.member2).post(`/api/items/${item.id}/assign`, { version: 2, assigneeId: null })).status).toBe(403);
    // ...and cannot use the release path to assign to someone else
    expect((await as(w.member).post(`/api/items/${item.id}/assign`, { version: 2, assigneeId: w.member2.id })).status).toBe(403);
    // started work can no longer be dropped by the member
    await go(w.member, item.id, 'in_progress');
    expect((await as(w.member).post(`/api/items/${item.id}/assign`, { version: 3, assigneeId: null })).status).toBe(409);
    await go(w.member, item.id, 'open');
    const rel = await as(w.member).post(`/api/items/${item.id}/assign`, { version: 4, assigneeId: null });
    expect(rel.status).toBe(200);
    expect(rel.body.item.assigneeId).toBeNull();
  });

  test('activity resolves assignee names and exposes reason requirements', async () => {
    const w = await makeWorld();
    const item = await makeItem(w, w.member);
    await as(w.lead).post(`/api/items/${item.id}/assign`, { version: 1, assigneeId: w.member2.id });
    const { activity } = (await as(w.viewer).get(`/api/items/${item.id}`)).body;
    expect(activity[0]).toMatchObject({ action: 'assignee_changed', newName: w.member2.name, oldName: null });
    await go(w.member2, item.id, 'in_progress');
    await go(w.member2, item.id, 'awaiting_approval');
    const caps = (await as(w.lead).get(`/api/items/${item.id}`)).body.item.capabilities;
    expect(caps.transitionRules).toEqual(expect.arrayContaining([{ to: 'resolved', needsReason: false }, { to: 'in_progress', needsReason: true }]));
  });
});

describe('dashboard', () => {
  test('shows assigned work, urgent unassigned items and approvals relevant to the viewer', async () => {
    const w = await makeWorld();
    const urgent = await makeItem(w, w.member, { priority: 'urgent', title: 'Urgent unassigned' });
    const mine = await makeItem(w, w.member, { title: 'My task' });
    await as(w.member).post(`/api/items/${mine.id}/claim`);
    const appr = await makeItem(w, w.member, { title: 'Needs approval' });
    await as(w.member).post(`/api/items/${appr.id}/claim`);
    await go(w.member, appr.id, 'in_progress');
    await go(w.member, appr.id, 'awaiting_approval');

    const m = (await as(w.member).get('/api/dashboard')).body;
    expect(m.assignedToMe.map((i) => i.title).sort()).toEqual(['My task', 'Needs approval']);
    expect(m.urgentUnassigned.map((i) => i.id)).toEqual([urgent.id]);
    expect(m.urgentUnassigned[0].canClaim).toBe(true);
    expect(m.awaitingApproval[0]).toMatchObject({ title: 'Needs approval', canApprove: false });

    const l = (await as(w.lead).get('/api/dashboard')).body;
    expect(l.assignedToMe).toEqual([]);
    expect(l.awaitingApproval[0].canApprove).toBe(true);

    const v = (await as(w.viewer).get('/api/dashboard')).body;
    expect(v.urgentUnassigned[0].canClaim).toBe(false);

    const o = (await as(w.outsider).get('/api/dashboard')).body;
    expect(o).toMatchObject({ assignedToMe: [], urgentUnassigned: [], awaitingApproval: [] });

    // once claimed, the item leaves the urgent-unassigned list
    await as(w.member2).post(`/api/items/${urgent.id}/claim`);
    expect((await as(w.lead).get('/api/dashboard')).body.urgentUnassigned).toEqual([]);
  });
});
