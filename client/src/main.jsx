import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, Link } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { ToastProvider } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Items from './pages/Items.jsx';
import ItemDetail from './pages/ItemDetail.jsx';
import Teams from './pages/Teams.jsx';
import './styles.css';

function Shell({ children }) {
  const { user, logout } = useAuth();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">Newtonite Ops</Link>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/items">Work items</NavLink>
          <NavLink to="/teams">Teams</NavLink>
        </nav>
        <div className="who">
          <span>{user.name}</span>
          <button className="btn sm" onClick={logout}>Sign out</button>
        </div>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}

function Gate() {
  const { loading, user } = useAuth();
  if (loading) return <div className="loading">Loading…</div>;
  if (!user) return <Login />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/items" element={<Items />} />
        <Route path="/items/:id" element={<ItemDetail />} />
        <Route path="/teams" element={<Teams />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Gate />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
