import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, patch, post } from '../api.js';
import {
  PRIORITY_LABEL, PriorityTag, STATUS_LABEL, STATUS_ORDER, StatusBadge, TRANSITION_LABEL, TYPE_LABEL, timeAgo, useToast,
} from '../components/ui.jsx';

function describe(a) {
  const who = a.actorName;
  const nm = (v) => v || 'nobody';
  switch (a.action) {
    case 'created': return <><b>{who}</b> created this item</>;
    case 'status_changed': return <><b>{who}</b> moved it from <b>{STATUS_LABEL[a.oldValue]}</b> to <b>{STATUS_LABEL[a.newValue]}</b></>;
    case 'priority_changed': return <><b>{who}</b> changed priority from <b>{PRIORITY_LABEL[a.oldValue]}</b> to <b>{PRIORITY_LABEL[a.newValue]}</b></>;
    case 'assignee_changed':
      if (a.comment === 'Claimed') return <><b>{who}</b> claimed it</>;
      return a.newValue == null
        ? <><b>{who}</b> unassigned <b>{nm(a.oldName)}</b></>
        : <><b>{who}</b> {a.oldValue == null ? 'assigned it to' : `reassigned it from ${nm(a.oldName)} to`} <b>{nm(a.newName)}</b></>;
    case 'field_updated': return <><b>{who}</b> edited the {a.field}</>;
    case 'comment_added': return <><b>{who}</b> commented</>;
    default: return <b>{who}</b>;
  }
}

export default function ItemDetail() {
  const { id } = useParams();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [members, setMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [comment, setComment] = useState('');
  const [pending, setPending] = useState(null); // transition awaiting a note
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await get(`/items/${id}`);
      setData(d);
      setError('');
      setConflict(false);
      return d;
    } catch (e) {
      setError(e.status === 404 ? 'This work item does not exist, or you do not have access to it.' : e.message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const teamId = data?.item.teamId;
  useEffect(() => {
    if (!teamId) return;
    get(`/teams/${teamId}/members`).then((r) => setMembers(r.members.filter((m) => m.role !== 'viewer'))).catch(() => {});
  }, [teamId]);

  /** Run a write; on a version conflict show the banner instead of silently overwriting. */
  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      await load();
      return true;
    } catch (e) {
      if (e.code === 'VERSION_CONFLICT') {
        setConflict(true);
        toast('Someone else changed this item. Review the latest version first.', 'error');
      } else {
        toast(e.message, 'error');
        if (e.code === 'ALREADY_ASSIGNED' || e.status === 409 || e.status === 422) await load();
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error) return <><p className="error">{error}</p><Link to="/items">Back to work items</Link></>;
  if (!data) return <div className="loading">Loading…</div>;

  const { item, activity } = data;
  const cap = item.capabilities;
  const v = item.version;

  const moves = cap.transitionRules.map((t) => ({ ...t, label: TRANSITION_LABEL[`${item.status}>${t.to}`] || STATUS_LABEL[t.to] }));
  const startTransition = (t) => (t.needsReason ? (setPending(t), setNote('')) : doTransition(t.to));
  const doTransition = async (to, comment) => {
    const ok = await run(() => post(`/items/${item.id}/transition`, { to, version: v, ...(comment ? { comment } : {}) }), `Moved to ${STATUS_LABEL[to]}.`);
    if (ok) setPending(null);
  };
  const saveEdit = async () => {
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, val]) => val !== item[k]));
    if (!Object.keys(changed).length) return setEditing(false);
    if (await run(() => patch(`/items/${item.id}`, { version: v, ...changed }), 'Saved.')) setEditing(false);
  };
  const reachedIdx = STATUS_ORDER.indexOf(item.status);

  return (
    <>
      <p style={{ margin: '0 0 .75rem' }}><Link to="/items">← Work items</Link></p>

      {conflict && (
        <div className="banner" role="alert">
          <span>Someone else changed this item while you were looking at it. Your change was not applied.</span>
          <button className="btn sm" onClick={() => { setEditing(false); load(); }}>Show latest</button>
        </div>
      )}

      <div className="page-head">
        <div>
          <h1>{item.title}</h1>
          <p className="sub">{item.teamName} · {TYPE_LABEL[item.type]} · created by {item.creatorName} {timeAgo(item.createdAt)}</p>
        </div>
        <PriorityTag priority={item.priority} />
      </div>

      <ol className="track" aria-label="Status">
        {STATUS_ORDER.map((s, i) => (
          <li key={s} className={i < reachedIdx ? 'done' : i === reachedIdx ? 'now' : ''} aria-current={i === reachedIdx ? 'step' : undefined}>
            {i + 1}. {STATUS_LABEL[s]}
          </li>
        ))}
      </ol>

      <div className="detail" style={{ marginTop: '1rem' }}>
        <div className="grid">
          <section className="card">
            <header>
              <h2>Details</h2>
              {cap.canEdit && !editing && (
                <button className="btn sm" onClick={() => { setDraft({ title: item.title, description: item.description, type: item.type, priority: item.priority }); setEditing(true); }}>Edit</button>
              )}
            </header>
            <div className="pad">
              {editing ? (
                <>
                  <div className="field"><label htmlFor="e-title">Title</label>
                    <input id="e-title" value={draft.title} maxLength={200} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
                  <div className="field"><label htmlFor="e-desc">Description</label>
                    <textarea id="e-desc" value={draft.description} maxLength={5000} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
                  <div className="field-row">
                    <div className="field"><label htmlFor="e-type">Type</label>
                      <select id="e-type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                        {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                    <div className="field"><label htmlFor="e-prio">Priority</label>
                      <select id="e-prio" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>
                        {Object.entries(PRIORITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                  </div>
                  <div className="actions">
                    <button className="btn primary" disabled={busy || !draft.title.trim()} onClick={saveEdit}>Save changes</button>
                    <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
                  </div>
                </>
              ) : (
                <p className="desc">{item.description || <span className="hint">No description.</span>}</p>
              )}
            </div>
          </section>

          <section className="card">
            <header><h2>Activity</h2><span className="count">{activity.length} events</span></header>
            {cap.canComment && (
              <form
                className="pad"
                style={{ borderBottom: '1px solid var(--line)' }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await run(() => post(`/items/${item.id}/comments`, { body: comment }), 'Comment added.')) setComment('');
                }}
              >
                <label htmlFor="comment">Add a comment</label>
                <textarea id="comment" value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 64 }} />
                <div style={{ marginTop: '.5rem' }}><button className="btn primary sm" disabled={busy || !comment.trim()}>Post comment</button></div>
              </form>
            )}
            <ul className="timeline">
              {activity.map((a) => (
                <li key={a.id}>
                  <div>{describe(a)} <span className="when">· {timeAgo(a.createdAt)}</span></div>
                  {a.action === 'comment_added' && <div className="comment">{a.comment}</div>}
                  {a.action !== 'comment_added' && a.comment && a.comment !== 'Claimed' && <div className="note">{a.comment}</div>}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="grid">
          <section className="card pad">
            <dl className="kv">
              <dt>Status</dt><dd><StatusBadge status={item.status} /></dd>
              <dt>Assignee</dt><dd>{item.assigneeName || 'Unassigned'}</dd>
              <dt>Updated</dt><dd>{timeAgo(item.updatedAt)}</dd>
                            <dt>Your role</dt><dd>{cap.role.charAt(0).toUpperCase() + cap.role.slice(1)}</dd>
            </dl>
          </section>

          {(cap.canClaim || moves.length > 0 || cap.canAssign || cap.canRelease) && (
            <section className="card pad">
              <h3>Actions</h3>
              <div className="actions">
                {cap.canClaim && (
                  <button className="btn primary" disabled={busy} onClick={() => run(() => post(`/items/${item.id}/claim`), 'Claimed. You are now working on it.')}>
                    Claim and start
                  </button>
                )}
                {moves.map((t) => (
                  <button key={t.to} className={`btn ${t.needsReason ? '' : 'primary'}`} disabled={busy} onClick={() => startTransition(t)}>
                    {t.label}
                  </button>
                ))}
                {cap.canRelease && (
                  <button className="btn" disabled={busy} onClick={() => run(() => post(`/items/${item.id}/assign`, { assigneeId: null, version: v }), 'Released back to the pool.')}>
                    Release
                  </button>
                )}
              </div>

              {pending && (
                <div style={{ marginTop: '.9rem' }}>
                  <label htmlFor="note">Reason (required)</label>
                  <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} style={{ minHeight: 70 }} autoFocus />
                  <div className="actions" style={{ marginTop: '.5rem' }}>
                    <button className="btn primary sm" disabled={busy || !note.trim()} onClick={() => doTransition(pending.to, note)}>{pending.label}</button>
                    <button className="btn sm" onClick={() => setPending(null)}>Cancel</button>
                  </div>
                </div>
              )}

              {cap.canAssign && (
                <div style={{ marginTop: '1rem' }}>
                  <label htmlFor="assign">Assign to</label>
                  <select
                    id="assign" disabled={busy} value={item.assigneeId ?? ''}
                    onChange={(e) => run(() => post(`/items/${item.id}/assign`, { assigneeId: e.target.value || null, version: v }), 'Assignee updated.')}
                  >
                    <option value="">Unassigned</option>
                    {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <span className="hint">Items can only be unassigned while Open; reassign started work instead.</span>
                </div>
              )}
            </section>
          )}

          {cap.role === 'viewer' && <p className="hint">You have read-only access to this team.</p>}
          {item.status === 'closed' && <p className="hint">Closed items are read-only.</p>}
        </aside>
      </div>
    </>
  );
}
