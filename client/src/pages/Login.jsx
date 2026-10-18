import { useState } from 'react';
import { useAuth } from '../auth.jsx';

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') await login(form.email, form.password);
      else await register(form.name, form.email, form.password);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const demo = (email) => setForm({ ...form, email, password: 'Password123!' });

  return (
    <div className="login">
      <div className="login-box">
        <h1>Newtonite Ops</h1>
        <p className="sub" style={{ marginBottom: '1rem' }}>Create, assign and resolve operational work.</p>
        <form className="card" onSubmit={submit}>
          {mode === 'register' && (
            <div className="field">
              <label htmlFor="name">Name</label>
              <input id="name" value={form.name} onChange={set('name')} required autoComplete="name" />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={form.email} onChange={set('email')} required autoComplete="email" />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password" type="password" value={form.password} onChange={set('password')} required minLength={mode === 'register' ? 8 : 1}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            {mode === 'register' && <span className="hint">At least 8 characters. A team admin must add you to a team before you see any work.</span>}
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
          <p className="demo">
            {mode === 'login' ? 'New here? ' : 'Already registered? '}
            <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </form>
        <p className="demo">
          Demo accounts (password <code>Password123!</code>):{' '}
          {[['admin', 'Admin'], ['lead', 'Lead'], ['alice', 'Member'], ['viewer', 'Viewer']].map(([n, r], i) => (
            <span key={n}>
              {i > 0 && ', '}
              <button type="button" onClick={() => { setMode('login'); demo(`${n}@demo.com`); }}>{r}</button>
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
