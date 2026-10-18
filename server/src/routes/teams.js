const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { AppError, notFound } = require('../errors');
const { parse, uuidParam } = require('../validate');
const { authenticate } = require('../auth');
const { ROLES, requireRole, requireMembership } = require('../rbac');
const { mutation } = require('../mutation');
const { logActivity } = require('../activity');

const router = express.Router();
router.use(authenticate);
router.param('teamId', uuidParam);
router.param('userId', uuidParam);

router.get('/', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT t.id, t.name, m.role,
              (SELECT count(*)::int FROM memberships x WHERE x.team_id = t.id) AS "memberCount"
         FROM memberships m JOIN teams t ON t.id = m.team_id
        WHERE m.user_id = $1 ORDER BY t.name`,
      [req.user.id]
    );
    res.json({ teams: r.rows });
  } catch (e) {
    next(e);
  }
});

// Anyone may create a team; they become its Admin.
router.post(
  '/',
  mutation(async (client, req) => {
    const { name } = parse(z.object({ name: z.string().trim().min(2).max(80) }), req.body);
    const t = (await client.query('INSERT INTO teams (name) VALUES ($1) RETURNING id, name', [name])).rows[0];
    await client.query(`INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, 'admin')`, [
      req.user.id,
      t.id,
    ]);
    return { status: 201, body: { team: { ...t, role: 'admin', memberCount: 1 } } };
  })
);

router.get('/:teamId/members', async (req, res, next) => {
  try {
    await requireMembership(db, req.user.id, req.params.teamId);
    const r = await db.query(
      `SELECT u.id, u.name, u.email, m.role FROM memberships m
         JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY u.name`,
      [req.params.teamId]
    );
    res.json({ members: r.rows });
  } catch (e) {
    next(e);
  }
});

/** Active items held by someone who leaves / is demoted to viewer go back to the pool. */
async function releaseItems(client, teamId, userId, actorId) {
  const items = (
    await client.query(
      `SELECT id, status FROM work_items
        WHERE team_id = $1 AND assignee_id = $2 AND status IN ('open','in_progress','awaiting_approval')
        FOR UPDATE`,
      [teamId, userId]
    )
  ).rows;
  for (const it of items) {
    await client.query(
      `UPDATE work_items SET assignee_id = NULL, status = 'open', version = version + 1, updated_at = now()
        WHERE id = $1`,
      [it.id]
    );
    await logActivity(client, {
      itemId: it.id, actorId, action: 'assignee_changed', field: 'assignee', oldValue: userId, newValue: null,
      comment: 'Unassigned automatically: assignee lost the right to work on this team',
    });
    if (it.status !== 'open') {
      await logActivity(client, {
        itemId: it.id, actorId, action: 'status_changed', field: 'status', oldValue: it.status, newValue: 'open',
      });
    }
  }
}

/** Lock all admin rows of a team so concurrent demotions can't both pass the "last admin" check. */
async function assertNotLastAdmin(client, teamId, userId) {
  const admins = (
    await client.query(`SELECT user_id FROM memberships WHERE team_id = $1 AND role = 'admin' FOR UPDATE`, [teamId])
  ).rows;
  if (admins.length === 1 && admins[0].user_id === userId) {
    throw new AppError(409, 'LAST_ADMIN', 'A team must keep at least one Admin');
  }
}

const addSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ROLES).default('member'),
});

router.post(
  '/:teamId/members',
  mutation(async (client, req) => {
    const role = await requireMembership(client, req.user.id, req.params.teamId);
    requireRole(role, 'admin', 'Only team Admins can add members');
    const body = parse(addSchema, req.body);
    const u = (await client.query('SELECT id, name, email FROM users WHERE lower(email) = $1', [body.email])).rows[0];
    if (!u) throw new AppError(404, 'USER_NOT_FOUND', 'No registered user with that email');
    const ins = await client.query(
      `INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [u.id, req.params.teamId, body.role]
    );
    if (!ins.rowCount) throw new AppError(409, 'ALREADY_MEMBER', 'User is already in this team');
    return { status: 201, body: { member: { ...u, role: body.role } } };
  })
);

router.patch(
  '/:teamId/members/:userId',
  mutation(async (client, req) => {
    const myRole = await requireMembership(client, req.user.id, req.params.teamId);
    requireRole(myRole, 'admin', 'Only team Admins can change roles');
    const { role } = parse(z.object({ role: z.enum(ROLES) }), req.body);
    const cur = (
      await client.query('SELECT role FROM memberships WHERE team_id = $1 AND user_id = $2', [
        req.params.teamId, req.params.userId,
      ])
    ).rows[0];
    if (!cur) throw notFound('Member');
    if (cur.role === 'admin' && role !== 'admin') {
      await assertNotLastAdmin(client, req.params.teamId, req.params.userId);
    }
    await client.query('UPDATE memberships SET role = $3 WHERE team_id = $1 AND user_id = $2', [
      req.params.teamId, req.params.userId, role,
    ]);
    if (role === 'viewer') await releaseItems(client, req.params.teamId, req.params.userId, req.user.id);
    return { status: 200, body: { userId: req.params.userId, role } };
  })
);

router.delete(
  '/:teamId/members/:userId',
  mutation(async (client, req) => {
    const myRole = await requireMembership(client, req.user.id, req.params.teamId);
    // Anyone may leave; removing someone else needs Admin.
    if (req.params.userId !== req.user.id) requireRole(myRole, 'admin', 'Only team Admins can remove members');
    const cur = (
      await client.query('SELECT role FROM memberships WHERE team_id = $1 AND user_id = $2', [
        req.params.teamId, req.params.userId,
      ])
    ).rows[0];
    if (!cur) throw notFound('Member');
    if (cur.role === 'admin') await assertNotLastAdmin(client, req.params.teamId, req.params.userId);
    await releaseItems(client, req.params.teamId, req.params.userId, req.user.id);
    await client.query('DELETE FROM memberships WHERE team_id = $1 AND user_id = $2', [
      req.params.teamId, req.params.userId,
    ]);
    return { status: 200, body: { removed: true } };
  })
);

module.exports = router;
