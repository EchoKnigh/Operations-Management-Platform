const { forbidden, notFound } = require('./errors');

// Server-side role hierarchy. The client never decides what a user may do.
const ROLE_RANK = { viewer: 0, member: 1, lead: 2, admin: 3 };
const ROLES = Object.keys(ROLE_RANK);

const atLeast = (role, min) => (ROLE_RANK[role] ?? -1) >= ROLE_RANK[min];

function requireRole(role, min, msg) {
  if (!atLeast(role, min)) {
    throw forbidden(msg || `This action requires the ${min} role or higher in this team`);
  }
}

async function getRole(client, userId, teamId) {
  const r = await client.query(
    'SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2',
    [userId, teamId]
  );
  return r.rows[0]?.role || null;
}

/** Non-members must not learn that a team/item exists, so they get 404, not 403. */
async function requireMembership(client, userId, teamId) {
  const role = await getRole(client, userId, teamId);
  if (!role) throw notFound('Team');
  return role;
}

module.exports = { ROLE_RANK, ROLES, atLeast, requireRole, getRole, requireMembership };
