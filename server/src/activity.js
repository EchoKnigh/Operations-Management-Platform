/** Append one row to the audit trail. Always called with the transaction's client. */
async function logActivity(client, { itemId, actorId, action, field = null, oldValue = null, newValue = null, comment = null }) {
  await client.query(
    `INSERT INTO activity (work_item_id, actor_id, action, field, old_value, new_value, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [itemId, actorId, action, field, oldValue, newValue, comment]
  );
}

const toActivity = (r) => ({
  id: Number(r.id),
  itemId: r.work_item_id,
  actorId: r.actor_id,
  actorName: r.actor_name || 'Deleted user',
  action: r.action,
  field: r.field,
  oldValue: r.old_value,
  newValue: r.new_value,
  // For assignee changes old/new values are user ids; names are resolved for display.
  oldName: r.old_name || null,
  newName: r.new_name || null,
  comment: r.comment,
  createdAt: r.created_at,
});

async function listActivity(client, itemId) {
  const r = await client.query(
    `SELECT a.*, u.name AS actor_name, ou.name AS old_name, nu.name AS new_name FROM activity a
       LEFT JOIN users u  ON u.id = a.actor_id
       LEFT JOIN users ou ON a.field = 'assignee' AND ou.id::text = a.old_value
       LEFT JOIN users nu ON a.field = 'assignee' AND nu.id::text = a.new_value
      WHERE a.work_item_id = $1 ORDER BY a.id DESC`,
    [itemId]
  );
  return r.rows.map(toActivity);
}

module.exports = { logActivity, listActivity };
