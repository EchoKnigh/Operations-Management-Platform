const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { AppError, notFound, forbidden } = require('../errors');
const { parse, uuidParam } = require('../validate');
const { authenticate } = require('../auth');
const { atLeast, requireRole, getRole } = require('../rbac');
const { mutation } = require('../mutation');
const { logActivity, listActivity } = require('../activity');
const { STATUSES, getRule, allowedNext } = require('../workflow');

const router = express.Router();
router.use(authenticate);
router.param('id', uuidParam);

const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const ACTIVE = ['open', 'in_progress', 'awaiting_approval'];

// ---------- helpers ----------

const ITEM_SQL = `
  SELECT w.*, a.name AS assignee_name, c.name AS creator_name, t.name AS team_name
    FROM work_items w
    LEFT JOIN users a ON a.id = w.assignee_id
    JOIN users c ON c.id = w.creator_id
    JOIN teams t ON t.id = w.team_id`;

const toItem = (r) => ({
  id: r.id,
  teamId: r.team_id,
  teamName: r.team_name,
  title: r.title,
  description: r.description,
  type: r.type,
  priority: r.priority,
  status: r.status,
  assigneeId: r.assignee_id,
  assigneeName: r.assignee_name || null,
  creatorId: r.creator_id,
  creatorName: r.creator_name,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** `lock` takes a row lock (FOR UPDATE OF w) so concurrent writers to this item serialise. */
async function fetchItem(client, id, lock = false) {
  const r = await client.query(`${ITEM_SQL} WHERE w.id = $1 ${lock ? 'FOR UPDATE OF w' : ''}`, [id]);
  return r.rows[0] ? toItem(r.rows[0]) : null;
}

/** Loads an item the actor is allowed to see; non-members get 404 (existence is not leaked). */
async function loadForActor(client, itemId, user, { lock = false } = {}) {
  const item = await fetchItem(client, itemId, lock);
  if (!item) throw notFound('Work item');
  const role = await getRole(client, user.id, item.teamId);
  if (!role) throw notFound('Work item');
  return { item, role };
}

const versionConflict = (item) =>
  new AppError(409, 'VERSION_CONFLICT', 'This item was changed by someone else. Reload and try again.', {
    current: item,
  });

/** Permissions the current actor has on an item - used by the UI to show/hide buttons. */
function capabilities(item, role, userId) {
  const mine = item.assigneeId === userId;
  const open = item.status !== 'closed';
  const transitions = allowedNext(item.status).filter((to) => {
    const rule = getRule(item.status, to);
    if (!atLeast(role, rule.minRole)) return false;
    if (rule.ownerOrLead && !atLeast(role, 'lead') && !mine) return false;
    if (rule.needsAssignee && !item.assigneeId) return false;
    if (rule.approval && item.assigneeId === userId && role !== 'admin') return false;
    return true;
  });
  const needsComment = (to) => !!getRule(item.status, to)?.needsComment;
  return {
    role,
    transitionRules: transitions.map((to) => ({ to, needsReason: needsComment(to) })),
    // A Member may hand back an item they claimed while it is still Open.
    canRelease: role === 'member' && mine && item.status === 'open',
    canEdit: open && atLeast(role, 'member') && (atLeast(role, 'lead') || mine || item.creatorId === userId),
    canComment: atLeast(role, 'member'),
    canClaim: !item.assigneeId && atLeast(role, 'member') && ACTIVE.includes(item.status),
    canAssign: atLeast(role, 'lead') && ACTIVE.includes(item.status),
    transitions,
  };
}

const withCaps = (item, role, userId) => ({ ...item, capabilities: capabilities(item, role, userId) });

// ---------- schemas ----------

const createSchema = z.object({
  teamId: z.string().uuid(),
  title: z.string().trim().min(3).max(200),
  description: z.string().max(5000).default(''),
  type: z.enum(TYPES).default('other'),
  priority: z.enum(PRIORITIES).default('medium'),
  assigneeId: z.string().uuid().nullable().optional(),
});

const patchSchema = z
  .object({
    version: z.number().int().positive(),
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().max(5000).optional(),
    type: z.enum(TYPES).optional(),
    priority: z.enum(PRIORITIES).optional(),
  })
  .strict();

const assignSchema = z.object({
  version: z.number().int().positive(),
  assigneeId: z.string().uuid().nullable(),
});

const transitionSchema = z.object({
  to: z.enum(STATUSES),
  comment: z.string().trim().max(2000).optional(),
  version: z.number().int().positive().optional(),
});

const commentSchema = z.object({ body: z.string().trim().min(1).max(2000) });

// ---------- list ----------

const listSchema = z.object({
  teamId: z.string().uuid().optional(),
  status: z.enum(STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(TYPES).optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

router.get('/', async (req, res, next) => {
  try {
    const f = parse(listSchema, req.query);
    // Authorization is part of the query: only teams the user belongs to can ever match.
    const where = [`w.team_id IN (SELECT team_id FROM memberships WHERE user_id = $1)`];
    const args = [req.user.id];
    const add = (sql, v) => {
      args.push(v);
      where.push(sql.replace('?', `$${args.length}`));
    };
    if (f.teamId) add('w.team_id = ?', f.teamId);
    if (f.status) add('w.status = ?', f.status);
    if (f.priority) add('w.priority = ?', f.priority);
    if (f.type) add('w.type = ?', f.type);
    if (f.assignee === 'me') add('w.assignee_id = ?', req.user.id);
    else if (f.assignee === 'unassigned') where.push('w.assignee_id IS NULL');
    else if (f.assignee) add('w.assignee_id = ?', f.assignee);
    if (f.q) {
      args.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); // escape LIKE wildcards in user input
      where.push(`(w.title ILIKE $${args.length} OR w.description ILIKE $${args.length})`);
    }
    const whereSql = where.join(' AND ');

    const total = (await db.query(`SELECT count(*)::int AS n FROM work_items w WHERE ${whereSql}`, args)).rows[0].n;
    const rows = (
      await db.query(
        `${ITEM_SQL} WHERE ${whereSql}
          ORDER BY CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                   w.updated_at DESC
          LIMIT ${f.pageSize} OFFSET ${(f.page - 1) * f.pageSize}`,
        args
      )
    ).rows;
    res.json({ items: rows.map(toItem), total, page: f.page, pageSize: f.pageSize });
  } catch (e) {
    next(e);
  }
});

// ---------- create ----------

router.post(
  '/',
  mutation(async (client, req) => {
    const b = parse(createSchema, req.body);
    const role = await getRole(client, req.user.id, b.teamId);
    if (!role) throw notFound('Team');
    requireRole(role, 'member', 'Viewers cannot create work items');
    if (b.assigneeId) {
      requireRole(role, 'lead', 'Only Leads and Admins can assign at creation time');
      const ar = await getRole(client, b.assigneeId, b.teamId);
      if (!ar || !atLeast(ar, 'member')) {
        throw new AppError(422, 'INVALID_ASSIGNEE', 'Assignee must be a Member or above in this team');
      }
    }
    const ins = await client.query(
      `INSERT INTO work_items (team_id, title, description, type, priority, assignee_id, creator_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.teamId, b.title, b.description, b.type, b.priority, b.assigneeId || null, req.user.id]
    );
    const id = ins.rows[0].id;
    await logActivity(client, { itemId: id, actorId: req.user.id, action: 'created', newValue: b.title });
    if (b.assigneeId) {
      await logActivity(client, {
        itemId: id, actorId: req.user.id, action: 'assignee_changed', field: 'assignee', newValue: b.assigneeId,
      });
    }
    const item = await fetchItem(client, id);
    return { status: 201, body: { item: withCaps(item, role, req.user.id) } };
  })
);

// ---------- read ----------

router.get('/:id', async (req, res, next) => {
  try {
    const { item, role } = await loadForActor(db, req.params.id, req.user);
    res.json({ item: withCaps(item, role, req.user.id), activity: await listActivity(db, item.id) });
  } catch (e) {
    next(e);
  }
});

router.get('/:id/activity', async (req, res, next) => {
  try {
    const { item } = await loadForActor(db, req.params.id, req.user);
    res.json({ activity: await listActivity(db, item.id) });
  } catch (e) {
    next(e);
  }
});

// ---------- update fields (optimistic locking) ----------

router.patch(
  '/:id',
  mutation(async (client, req) => {
    const b = parse(patchSchema, req.body);
    const { item, role } = await loadForActor(client, req.params.id, req.user, { lock: true });
    requireRole(role, 'member', 'Viewers cannot edit work items');
    if (!atLeast(role, 'lead') && item.assigneeId !== req.user.id && item.creatorId !== req.user.id) {
      throw forbidden('Members can only edit items they created or are assigned to');
    }
    if (item.status === 'closed') throw new AppError(409, 'ITEM_CLOSED', 'Closed items cannot be edited');
    if (item.version !== b.version) throw versionConflict(item);

    const changes = [];
    for (const f of ['title', 'description', 'type', 'priority']) {
      if (b[f] !== undefined && b[f] !== item[f]) changes.push([f, item[f], b[f]]);
    }
    if (!changes.length) return { status: 200, body: { item: withCaps(item, role, req.user.id) } };

    const sets = changes.map(([f], i) => `${f} = $${i + 3}`).join(', ');
    await client.query(
      `UPDATE work_items SET ${sets}, version = version + 1, updated_at = now() WHERE id = $1 AND version = $2`,
      [item.id, item.version, ...changes.map((c) => c[2])]
    );
    for (const [f, o, n] of changes) {
      await logActivity(client, {
        itemId: item.id,
        actorId: req.user.id,
        action: f === 'priority' ? 'priority_changed' : 'field_updated',
        field: f,
        oldValue: f === 'description' ? null : o, // don't copy long text into the log
        newValue: f === 'description' ? null : n,
      });
    }
    return { status: 200, body: { item: withCaps(await fetchItem(client, item.id), role, req.user.id) } };
  })
);

// ---------- claim (atomic compare-and-set) ----------

router.post(
  '/:id/claim',
  mutation(async (client, req) => {
    const { item, role } = await loadForActor(client, req.params.id, req.user);
    requireRole(role, 'member', 'Viewers cannot claim work items');
    // The WHERE clause IS the guard. Under READ COMMITTED a concurrent claimer blocks on the
    // row lock, then re-checks `assignee_id IS NULL` against the committed row and updates 0 rows.
    const r = await client.query(
      `UPDATE work_items SET assignee_id = $1, version = version + 1, updated_at = now()
        WHERE id = $2 AND assignee_id IS NULL AND status IN ('open','in_progress','awaiting_approval')
        RETURNING id`,
      [req.user.id, item.id]
    );
    if (!r.rowCount) {
      const cur = await fetchItem(client, item.id);
      if (cur.assigneeId) {
        throw new AppError(409, 'ALREADY_ASSIGNED', `Already claimed by ${cur.assigneeName}`, { current: cur });
      }
      throw new AppError(409, 'NOT_CLAIMABLE', `Items that are ${cur.status} cannot be claimed`, { current: cur });
    }
    await logActivity(client, {
      itemId: item.id, actorId: req.user.id, action: 'assignee_changed', field: 'assignee',
      oldValue: null, newValue: req.user.id, comment: 'Claimed',
    });
    return { status: 200, body: { item: withCaps(await fetchItem(client, item.id), role, req.user.id) } };
  })
);

// ---------- assign / reassign / unassign ----------

router.post(
  '/:id/assign',
  mutation(async (client, req) => {
    const b = parse(assignSchema, req.body);
    const { item, role } = await loadForActor(client, req.params.id, req.user, { lock: true });
    const releasingOwnClaim = b.assigneeId === null && item.assigneeId === req.user.id && role === 'member';
    if (!releasingOwnClaim) requireRole(role, 'lead', 'Only Leads and Admins can assign work');
    if (item.version !== b.version) throw versionConflict(item);
    if (!ACTIVE.includes(item.status)) {
      throw new AppError(409, 'INVALID_STATE', `Cannot change the assignee of a ${item.status} item`);
    }
    if (b.assigneeId === null && item.status !== 'open') {
      throw new AppError(409, 'INVALID_STATE', 'Only open items can be unassigned; reassign it instead');
    }
    if (b.assigneeId) {
      const ar = await getRole(client, b.assigneeId, item.teamId);
      if (!ar || !atLeast(ar, 'member')) {
        throw new AppError(422, 'INVALID_ASSIGNEE', 'Assignee must be a Member or above in this team');
      }
    }
    if (b.assigneeId === item.assigneeId) {
      return { status: 200, body: { item: withCaps(item, role, req.user.id) } };
    }
    await client.query(
      `UPDATE work_items SET assignee_id = $2, version = version + 1, updated_at = now() WHERE id = $1`,
      [item.id, b.assigneeId]
    );
    await logActivity(client, {
      itemId: item.id, actorId: req.user.id, action: 'assignee_changed', field: 'assignee',
      oldValue: item.assigneeId, newValue: b.assigneeId,
    });
    return { status: 200, body: { item: withCaps(await fetchItem(client, item.id), role, req.user.id) } };
  })
);

// ---------- status workflow ----------

router.post(
  '/:id/transition',
  mutation(async (client, req) => {
    const b = parse(transitionSchema, req.body);
    const { item, role } = await loadForActor(client, req.params.id, req.user, { lock: true });
    if (b.version !== undefined && b.version !== item.version) throw versionConflict(item);

    const rule = getRule(item.status, b.to);
    if (!rule) {
      throw new AppError(409, 'INVALID_TRANSITION', `Cannot move from ${item.status} to ${b.to}`, {
        current: item, allowed: allowedNext(item.status),
      });
    }
    requireRole(role, rule.minRole, `Moving to ${b.to} requires the ${rule.minRole} role or higher`);
    if (rule.ownerOrLead && !atLeast(role, 'lead') && item.assigneeId !== req.user.id) {
      throw forbidden('Members can only move items assigned to them');
    }
    if (rule.needsAssignee && !item.assigneeId) {
      throw new AppError(422, 'ASSIGNEE_REQUIRED', 'Assign or claim the item before starting work');
    }
    if (rule.approval && item.assigneeId === req.user.id && role !== 'admin') {
      throw forbidden('You cannot approve work assigned to you; ask another Lead or an Admin');
    }
    if (rule.needsComment && !b.comment) {
      throw new AppError(422, 'COMMENT_REQUIRED', `A reason is required to move to ${b.to}`);
    }

    await client.query(
      `UPDATE work_items SET status = $2, version = version + 1, updated_at = now() WHERE id = $1`,
      [item.id, b.to]
    );
    await logActivity(client, {
      itemId: item.id, actorId: req.user.id, action: 'status_changed', field: 'status',
      oldValue: item.status, newValue: b.to, comment: b.comment || null,
    });
    return { status: 200, body: { item: withCaps(await fetchItem(client, item.id), role, req.user.id) } };
  })
);

// ---------- comments ----------

router.post(
  '/:id/comments',
  mutation(async (client, req) => {
    const b = parse(commentSchema, req.body);
    // Comments don't change item state, so no row lock / version bump is needed.
    const { item, role } = await loadForActor(client, req.params.id, req.user);
    requireRole(role, 'member', 'Viewers cannot comment');
    await logActivity(client, { itemId: item.id, actorId: req.user.id, action: 'comment_added', comment: b.body });
    const activity = await listActivity(client, item.id);
    return { status: 201, body: { activity: activity[0] } };
  })
);

module.exports = router;
