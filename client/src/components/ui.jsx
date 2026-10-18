import { createContext, useCallback, useContext, useState } from 'react';
import { Link } from 'react-router-dom';

export const STATUS_LABEL = {
  open: 'Open',
  in_progress: 'In progress',
  awaiting_approval: 'Awaiting approval',
  resolved: 'Resolved',
  closed: 'Closed',
};
export const STATUS_ORDER = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];
export const TYPE_LABEL = {
  incident: 'Incident',
  customer_issue: 'Customer issue',
  payment: 'Payment',
  compliance: 'Compliance',
  other: 'Other',
};
export const PRIORITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
export const ROLE_LABEL = { viewer: 'Viewer', member: 'Member', lead: 'Lead', admin: 'Admin' };

export const StatusBadge = ({ status }) => <span className={`badge status-${status.toUpperCase()}`}>{STATUS_LABEL[status]}</span>;
export const PriorityTag = ({ priority }) => (
  <span className={`prio prio-${priority.toUpperCase()}`}>
    <i aria-hidden="true" />
    {PRIORITY_LABEL[priority]}
  </span>
);

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** A compact work-item row used by the dashboard queues and the list page. */
export function ItemRow({ item, children, showTeam = true }) {
  return (
    <li className={`row rail-${item.priority.toUpperCase()}`}>
      <div className="row-main">
        <Link to={`/items/${item.id}`} className="row-title">
          {item.title}
        </Link>
        <div className="row-meta">
          <PriorityTag priority={item.priority} />
          <span>{TYPE_LABEL[item.type]}</span>
          {showTeam && <span>{item.teamName}</span>}
          <span>{item.assigneeName || 'Unassigned'}</span>
          <span>{timeAgo(item.updatedAt)}</span>
        </div>
      </div>
      {children && <div className="row-actions">{children}</div>}
    </li>
  );
}

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, kind = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Modal({ title, onClose, children }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            Close
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

export const Empty = ({ children }) => <p className="empty">{children}</p>;

/** Button labels for each workflow move. The server decides which moves are allowed. */
export const TRANSITION_LABEL = {
  'open>in_progress': 'Start work',
  'in_progress>open': 'Pause (back to Open)',
  'in_progress>awaiting_approval': 'Submit for approval',
  'awaiting_approval>resolved': 'Approve and resolve',
  'awaiting_approval>in_progress': 'Reject (send back)',
  'resolved>closed': 'Close item',
  'resolved>in_progress': 'Reopen',
};
