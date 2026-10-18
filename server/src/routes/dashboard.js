const express = require('express');
const db = require('../db');
const { authenticate } = require('../auth');

const router = express.Router();
router.use(authenticate);

const COLS = `w.id, w.title, w.type, w.priority, w.status, w.version, w.team_id AS "teamId", t.name AS "teamName",
  w.assignee_id AS "assigneeId", a.name AS "assigneeName", w.updated_at AS "updatedAt", w.created_at AS "createdAt",
  m.role AS "myRole"`;
const FROM = `FROM work_items w
  JOIN memberships m ON m.team_id = w.team_id AND m.user_id = $1
  JOIN teams t ON t.id = w.team_id
  LEFT JOIN users a ON a.id = w.assignee_id`;
const PRIO = `CASE w.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [assigned, urgent, approvals, counts] = await Promise.all([
      db.query(
        `SELECT ${COLS} ${FROM}
          WHERE w.assignee_id = $1 AND w.status IN ('open','in_progress','awaiting_approval')
          ORDER BY ${PRIO}, w.updated_at DESC LIMIT 50`,
        [uid]
      ),
      db.query(
        `SELECT ${COLS} ${FROM}
          WHERE w.assignee_id IS NULL AND w.priority = 'urgent' AND w.status = 'open'
          ORDER BY w.created_at ASC LIMIT 50`,
        [uid]
      ),
      db.query(
        `SELECT ${COLS} ${FROM}
          WHERE w.status = 'awaiting_approval'
          ORDER BY w.updated_at ASC LIMIT 50`,
        [uid]
      ),
      db.query(
        `SELECT w.status, count(*)::int AS n ${FROM} GROUP BY w.status`,
        [uid]
      ),
    ]);

    const canApprove = (r) => (r.myRole === 'lead' || r.myRole === 'admin') && (r.assigneeId !== uid || r.myRole === 'admin');
    const canClaim = (r) => r.myRole !== 'viewer';
    const statusCounts = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));

    res.json({
      assignedToMe: assigned.rows,
      urgentUnassigned: urgent.rows.map((r) => ({ ...r, canClaim: canClaim(r) })),
      awaitingApproval: approvals.rows.map((r) => ({ ...r, canApprove: canApprove(r) })),
      statusCounts,
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
