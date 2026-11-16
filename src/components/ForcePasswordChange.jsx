import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { apiChangePassword } from '../utils/adminApi.js';

// Shown over every page while the signed-in account still has a temporary password.
export default function ForcePasswordChange() {
  const { user, setUser, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!user?.mustChangePassword) return null;

  const submit = async (e) => {
    e.preventDefault();
    if (next.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (next !== confirm) { setError('The new passwords do not match.'); return; }
    setBusy(true);
    setError('');
    try {
      const { user: fresh } = await apiChangePassword(current, next);
      setUser(fresh);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="adm-backdrop">
      <div className="adm-modal" role="dialog" aria-modal="true" aria-label="Change password">
        <div className="adm-modal-head"><h3>Choose a new password</h3></div>
        <form className="adm-form" onSubmit={submit}>
          <p className="adm-hint">You are using a temporary password. Choose your own before continuing.</p>
          {error && <div className="adm-error">{error}</div>}
          <label><span>Current (temporary) password</span>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
          </label>
          <label><span>New password (min. 8 characters)</span>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
          </label>
          <label><span>Confirm new password</span>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
          </label>
          <div className="adm-actions">
            <button type="button" className="adm-btn" onClick={logout}>Sign out</button>
            <button type="submit" className="adm-btn adm-primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
