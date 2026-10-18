// The status workflow lives in one place so the API, UI hints and tests agree.
//   Open -> In Progress -> Awaiting Approval -> Resolved -> Closed
// Plus a few controlled "backwards" moves (pause, reject, reopen).

const STATUSES = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];

/**
 * minRole:        lowest team role allowed to perform the move
 * ownerOrLead:    a plain Member may only do it on items assigned to them
 * needsAssignee:  item must have an assignee afterwards
 * needsComment:   a reason must be supplied (rejections / reopen)
 * approval:       four-eyes rule - the assignee cannot approve their own work (Admin may)
 */
const TRANSITIONS = {
  open: {
    in_progress: { minRole: 'member', ownerOrLead: true, needsAssignee: true },
  },
  in_progress: {
    open: { minRole: 'member', ownerOrLead: true },
    awaiting_approval: { minRole: 'member', ownerOrLead: true },
  },
  awaiting_approval: {
    resolved: { minRole: 'lead', approval: true },
    in_progress: { minRole: 'lead', needsComment: true },
  },
  resolved: {
    closed: { minRole: 'lead' },
    in_progress: { minRole: 'lead', needsComment: true },
  },
  closed: {},
};

const getRule = (from, to) => TRANSITIONS[from]?.[to] || null;
const allowedNext = (from) => Object.keys(TRANSITIONS[from] || {});

module.exports = { STATUSES, TRANSITIONS, getRule, allowedNext };
