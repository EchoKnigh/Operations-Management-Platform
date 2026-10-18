import { useCallback, useEffect, useState } from 'react';
import { del, get, patch, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Empty, ROLE_LABEL, useToast } from '../components/ui.jsx';

function Members({ team, me }) {
  const toast = useToast();
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const isAdmin = team.role === 'admin';

  const load = useCallback(async () => {
    try { setMembers((await get(`/teams/${team.id}/members`)).members); } catch (e) { toast(e.message, 'error'); }
  }, [team.id, toast]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn, msg) => {
    try { await fn(); toast(msg); } catch (e) { toast(e.message, 'error'); }
    load();
  };

  return (
    <section className="card">
      <header><h2>{team.name}</h2><span className="count">You are {ROLE_LABEL[team.role].toLowerCase() === 'admin' ? 'an admin' : `a ${ROLE_LABEL[team.role].toLowerCase()}`}</span></header>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th>{isAdmin && <th />}</tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.name}{m.id === me.id && <span className="hint"> (you)</span>}</td>
              <td>{m.email}</td>
              <td>
                {isAdmin ? (
                  <select aria-label={`Role for ${m.name}`} value={m.role} style={{ width: 'auto' }}
                    onChange={(e) => run(() => patch(`/teams/${team.id}/members/${m.id}`, { role: e.target.value }), 'Role updated.')}>
                    {Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                ) : ROLE_LABEL[m.role]}
              </td>
              {isAdmin && (
                <td style={{ textAlign: 'right' }}>
                  <button className="btn danger sm" onClick={() => window.confirm(`Remove ${m.name} from ${team.name}? Their open items go back to the pool.`) && run(() => del(`/teams/${team.id}/members/${m.id}`), 'Member removed.')}>Remove</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {isAdmin && (
        <form className="pad" style={{ borderTop: '1px solid var(--line)', display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '.6rem', alignItems: 'end' }}
          onSubmit={async (e) => { e.preventDefault(); await run(() => post(`/teams/${team.id}/members`, { email, role }), 'Member added.'); setEmail(''); }}>
          <div><label htmlFor={`e-${team.id}`}>Add a registered user by email</label>
            <input id={`e-${team.id}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div><label htmlFor={`r-${team.id}`}>Role</label>
            <select id={`r-${team.id}`} value={role} onChange={(e) => setRole(e.target.value)}>
              {Object.entries(ROLE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <button className="btn primary">Add member</button>
        </form>
      )}
    </section>
  );
}

export default function Teams() {
  const { teams, user, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState('');

  return (
    <>
      <div className="page-head">
        <div><h1>Teams</h1><p className="sub">Roles are per team. Only admins can change membership.</p></div>
      </div>
      <div className="grid">
        {teams.length === 0 && <section className="card"><Empty>You are not in any team yet. Create one below, or ask an admin to add you.</Empty></section>}
        {teams.map((t) => <Members key={t.id} team={t} me={user} />)}
        <form className="card pad" style={{ display: 'flex', gap: '.6rem', alignItems: 'end' }}
          onSubmit={async (e) => {
            e.preventDefault();
            try { await post('/teams', { name }); toast('Team created. You are its admin.'); setName(''); await refresh(); } catch (err) { toast(err.message, 'error'); }
          }}>
          <div style={{ flex: 1 }}><label htmlFor="team-name">Create a new team</label>
            <input id="team-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /></div>
          <button className="btn primary">Create team</button>
        </form>
      </div>
    </>
  );
}
