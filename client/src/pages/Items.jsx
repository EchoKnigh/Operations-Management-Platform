import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, qs } from '../api.js';
import { useAuth } from '../auth.jsx';
import NewItemModal from '../components/NewItemModal.jsx';
import { Empty, ItemRow, PRIORITY_LABEL, STATUS_LABEL, StatusBadge, TYPE_LABEL } from '../components/ui.jsx';

const PAGE_SIZE = 20;

export default function Items() {
  const { teams } = useAuth();
  const nav = useNavigate();
  const [filters, setFilters] = useState({ q: '', teamId: '', status: '', priority: '', type: '', assignee: '' });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setResult(await get(`/items${qs({ ...filters, page, pageSize: PAGE_SIZE })}`));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [filters, page]);

  // debounce typing in the search box; other filters apply immediately
  useEffect(() => {
    const t = setTimeout(load, filters.q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, filters.q]);

  const set = (k) => (e) => {
    setFilters({ ...filters, [k]: e.target.value });
    setPage(1);
  };
  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Work items</h1>
          <p className="sub">Everything in the teams you belong to.</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>New work item</button>
      </div>

      <section className="card">
        <div className="filters">
          <input aria-label="Search" placeholder="Search title or description" value={filters.q} onChange={set('q')} />
          <select aria-label="Team" value={filters.teamId} onChange={set('teamId')}>
            <option value="">All teams</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select aria-label="Status" value={filters.status} onChange={set('status')}>
            <option value="">Any status</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="Priority" value={filters.priority} onChange={set('priority')}>
            <option value="">Any priority</option>
            {Object.entries(PRIORITY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="Type" value={filters.type} onChange={set('type')}>
            <option value="">Any type</option>
            {Object.entries(TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select aria-label="Assignee" value={filters.assignee} onChange={set('assignee')}>
            <option value="">Anyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
          </select>
        </div>

        {error && <p className="error pad">{error}</p>}
        {!result && !error && <div className="loading">Loading…</div>}
        {result && result.items.length === 0 && <Empty>No work items match these filters.</Empty>}
        {result && result.items.length > 0 && (
          <ul className="rows">
            {result.items.map((it) => (
              <ItemRow key={it.id} item={it}>
                <StatusBadge status={it.status} />
              </ItemRow>
            ))}
          </ul>
        )}
        {result && (
          <div className="pager">
            <span>{result.total} {result.total === 1 ? 'item' : 'items'}</span>
            <span className="actions">
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span>Page {page} of {pages}</span>
              <button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </span>
          </div>
        )}
      </section>

      {creating && (
        <NewItemModal
          onClose={() => setCreating(false)}
          onCreated={(item) => nav(`/items/${item.id}`)}
        />
      )}
    </>
  );
}
