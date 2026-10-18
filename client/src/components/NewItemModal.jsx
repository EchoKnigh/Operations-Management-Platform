import { useEffect, useRef, useState } from 'react';
import { get, newKey, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Modal, PRIORITY_LABEL, TYPE_LABEL } from './ui.jsx';

const WRITER = ['member', 'lead', 'admin'];

export default function NewItemModal({ onClose, onCreated }) {
  const { teams, user } = useAuth();
  const writable = teams.filter((t) => WRITER.includes(t.role));
  const [form, setForm] = useState({
    teamId: writable[0]?.id ?? '', title: '', description: '', type: 'incident', priority: 'medium', assigneeId: '',
  });
  const [members, setMembers] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // One key per "intent to create". If the request fails in transit and the user presses Create
  // again, the same key is sent, so the server can never create the item twice.
  const keyRef = useRef(newKey());
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const role = teams.find((t) => t.id === form.teamId)?.role;

  useEffect(() => {
    if (!form.teamId) return;
    get(`/teams/${form.teamId}/members`).then((r) => setMembers(r.members.filter((m) => WRITER.includes(m.role)))).catch(() => {});
  }, [form.teamId]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { item } = await post(
        '/items',
        { ...form, assigneeId: form.assigneeId || null },
        { key: keyRef.current }
      );
      onCreated(item);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New work item" onClose={onClose}>
      {writable.length === 0 ? (
        <p className="error">You need Member access or higher in a team to create work items.</p>
      ) : (
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="team">Team</label>
            <select id="team" value={form.teamId} onChange={set('teamId')}>
              {writable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="title">Title</label>
            <input id="title" value={form.title} onChange={set('title')} required maxLength={200} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="desc">Description</label>
            <textarea id="desc" value={form.description} onChange={set('description')} maxLength={5000} />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="type">Type</label>
              <select id="type" value={form.type} onChange={set('type')}>
                {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="prio">Priority</label>
              <select id="prio" value={form.priority} onChange={set('priority')}>
                {Object.entries(PRIORITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="assignee">Assignee</label>
            <select id="assignee" value={form.assigneeId} onChange={set('assigneeId')}>
              <option value="">Unassigned</option>
              {members
                .filter((m) => role === 'lead' || role === 'admin' || m.id === user.id /* members: self only; the server enforces it too */)
                .map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            {role === 'member' && <span className="hint">Members can leave it unassigned and claim it, or assign it to themselves.</span>}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button className="btn primary" disabled={busy}>Create work item</button>
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
