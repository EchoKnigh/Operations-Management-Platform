import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Empty, ItemRow, STATUS_LABEL, STATUS_ORDER, useToast } from '../components/ui.jsx';

export default function Dashboard() {
  const { user, teams } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await get('/dashboard'));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (item, fn, done) => {
    setBusyId(item.id);
    try {
      await fn();
      toast(done);
    } catch (e) {
      toast(e.message, 'error'); // e.g. "This item is already assigned to Alice" when someone beat us to it
    } finally {
      setBusyId(null);
      load();
    }
  };

  const claim = (it) => act(it, () => post(`/items/${it.id}/claim`), 'Claimed. It is now in your queue.');
  const approve = (it) =>
    act(it, () => post(`/items/${it.id}/transition`, { to: 'resolved', version: it.version }), 'Approved and resolved.');

  if (error) return <p className="error">{error}</p>;
  if (!data) return <div className="loading">Loading…</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Hello, {user.name.split(' ')[0]}</h1>
          <p className="sub">
            {teams.length ? `Your teams: ${teams.map((t) => t.name).join(', ')}` : 'You are not in a team yet.'}
          </p>
        </div>
        <Link className="btn" to="/items">All work items</Link>
      </div>

      {teams.length === 0 && (
        <div className="banner">Ask a team admin to add {user.email}, or create your own team under Teams.</div>
      )}

      <div className="stats">
        {STATUS_ORDER.map((s) => (
          <div className="stat" key={s}>
            <b>{data.statusCounts[s] ?? 0}</b>
            <span>{STATUS_LABEL[s]}</span>
          </div>
        ))}
      </div>

      <div className="grid dash">
        <section className="card">
          <header><h2>Assigned to me</h2><span className="count">{data.assignedToMe.length}</span></header>
          {data.assignedToMe.length === 0 ? (
            <Empty>Nothing assigned. Claim an urgent item or pick one from Work items.</Empty>
          ) : (
            <ul className="rows">
              {data.assignedToMe.map((it) => (
                <ItemRow key={it.id} item={it}>
                  <span className="badge">{STATUS_LABEL[it.status]}</span>
                </ItemRow>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <header><h2>Urgent and unassigned</h2><span className="count">{data.urgentUnassigned.length}</span></header>
          {data.urgentUnassigned.length === 0 ? (
            <Empty>No urgent work is waiting for an owner.</Empty>
          ) : (
            <ul className="rows">
              {data.urgentUnassigned.map((it) => (
                <ItemRow key={it.id} item={it}>
                  {it.canClaim && (
                    <button className="btn primary sm" disabled={busyId === it.id} onClick={() => claim(it)}>
                      Claim
                    </button>
                  )}
                </ItemRow>
              ))}
            </ul>
          )}
        </section>

        <section className="card span-all">
          <header><h2>Awaiting approval</h2><span className="count">{data.awaitingApproval.length}</span></header>
          {data.awaitingApproval.length === 0 ? (
            <Empty>No items are waiting for review.</Empty>
          ) : (
            <ul className="rows">
              {data.awaitingApproval.map((it) => (
                <ItemRow key={it.id} item={it}>
                  <Link className="btn sm" to={`/items/${it.id}`}>Review</Link>
                  {it.canApprove && (
                    <button className="btn primary sm" disabled={busyId === it.id} onClick={() => approve(it)}>
                      Approve
                    </button>
                  )}
                </ItemRow>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
