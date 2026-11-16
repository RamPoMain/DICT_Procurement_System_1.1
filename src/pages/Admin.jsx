import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import {
  adminMeta, adminListAccounts, adminCreateAccount, adminUpdateAccount, adminResetPassword,
  adminSaveFlow, adminAudit, adminTestEmail, refreshFlow
} from '../utils/adminApi.js';

const norm = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function Modal({ title, onClose, children }) {
  return (
    <div className="adm-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="adm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="adm-modal-head">
          <h3>{title}</h3>
          <button type="button" className="adm-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
function AccountForm({ meta, account, onClose, onSaved }) {
  const isEdit = !!account;
  const firstType = meta.types.find((t) => t.key === 'requester') || meta.types[0];
  const [form, setForm] = useState({
    type: account?.type || firstType.key,
    email: account?.email || '',
    roleName: account?.roleName || '',
    role: account?.role || '',
    office: account?.office || '',
    password: ''
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const type = meta.types.find((t) => t.key === form.type);
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { type: form.type, email: form.email, roleName: form.roleName, role: form.role, office: form.office };
      if (isEdit) await adminUpdateAccount(account.id, body);
      else await adminCreateAccount({ ...body, password: form.password });
      onSaved(isEdit ? 'Account updated.' : 'Account created. The person must change the password at first sign-in.');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title={isEdit ? 'Edit account' : 'Add account'} onClose={onClose}>
      <form className="adm-form" onSubmit={submit}>
        {error && <div className="adm-error">{error}</div>}
        <label>
          <span>Account type</span>
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            {meta.types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label>
          <span>Email (used to sign in)</span>
          <input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required />
        </label>
        <label>
          <span>Display name</span>
          <input value={form.roleName} onChange={(e) => set('roleName', e.target.value)} placeholder={type?.label} required />
        </label>
        {type?.editableRole && (
          <label>
            <span>Role code</span>
            <input value={form.role} onChange={(e) => set('role', e.target.value)} placeholder="e.g. ILCDB" required />
          </label>
        )}
        {(type?.needsOffice || form.office) && (
          <label>
            <span>Office{type?.needsOffice ? '' : ' (optional)'}</span>
            <input list="adm-offices" value={form.office} onChange={(e) => set('office', e.target.value)} required={type?.needsOffice} />
            <datalist id="adm-offices">{meta.offices.map((o) => <option key={o} value={o} />)}</datalist>
          </label>
        )}
        {!isEdit && (
          <label>
            <span>Temporary password (min. 8 characters)</span>
            <div className="adm-row">
              <input value={form.password} onChange={(e) => set('password', e.target.value)} minLength={8} required />
              <button type="button" className="adm-btn" onClick={() => set('password', randomPassword())}>Generate</button>
            </div>
          </label>
        )}
        <p className="adm-hint">
          The account type decides what the person can do (request, approve at a stage, track approvals).
          {isEdit && ' Changing the office of a Unit Head changes which PPMPs they can approve.'}
        </p>
        <div className="adm-actions">
          <button type="button" className="adm-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="adm-btn adm-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordForm({ account, onClose, onSaved }) {
  const [password, setPassword] = useState(randomPassword);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminResetPassword(account.id, password);
      onSaved(`Password reset for ${account.email}. Give them the new temporary password: ${password}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Reset password – ${account.email}`} onClose={onClose}>
      <form className="adm-form" onSubmit={submit}>
        {error && <div className="adm-error">{error}</div>}
        <label>
          <span>New temporary password</span>
          <div className="adm-row">
            <input value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
            <button type="button" className="adm-btn" onClick={() => setPassword(randomPassword())}>Generate</button>
          </div>
        </label>
        <p className="adm-hint">They will be asked to choose their own password at the next sign-in. Share this one privately.</p>
        <div className="adm-actions">
          <button type="button" className="adm-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="adm-btn adm-primary" disabled={busy}>Reset password</button>
        </div>
      </form>
    </Modal>
  );
}

function AccountsTab({ accounts, meta, me, reload, flash }) {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null); // account | 'new'
  const [resetting, setResetting] = useState(null);
  const typeLabel = (key) => meta.types.find((t) => t.key === key)?.label || key;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return accounts
      .filter((a) => !q || [a.email, a.roleName, a.office, typeLabel(a.type)].join(' ').toLowerCase().includes(q))
      .sort((a, b) => typeLabel(a.type).localeCompare(typeLabel(b.type)) || a.email.localeCompare(b.email));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, search, meta]);

  const toggleActive = async (a) => {
    try {
      await adminUpdateAccount(a.id, { active: !a.active });
      flash(a.active ? `${a.email} deactivated. They can no longer sign in.` : `${a.email} reactivated.`);
      reload();
    } catch (err) {
      flash(err.message, true);
    }
  };

  return (
    <section>
      <div className="adm-toolbar">
        <input className="adm-search" placeholder="Search accounts…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className="adm-btn adm-primary" onClick={() => setEditing('new')}>+ Add account</button>
      </div>
      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead>
            <tr><th>Email</th><th>Name</th><th>Type</th><th>Office</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className={a.active ? '' : 'is-off'}>
                <td>{a.email}{a.id === me.id && <span className="adm-tag">you</span>}</td>
                <td>{a.roleName}</td>
                <td>{typeLabel(a.type)}</td>
                <td>{a.office || '—'}</td>
                <td>
                  <span className={`adm-pill ${a.active ? 'ok' : 'off'}`}>{a.active ? 'Active' : 'Inactive'}</span>
                  {a.mustChangePassword && <span className="adm-pill warn">Temp password</span>}
                </td>
                <td className="adm-row-actions">
                  <button type="button" className="adm-link" onClick={() => setEditing(a)}>Edit</button>
                  <button type="button" className="adm-link" onClick={() => setResetting(a)}>Reset password</button>
                  {a.id !== me.id && (
                    <button type="button" className="adm-link danger" onClick={() => toggleActive(a)}>
                      {a.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="adm-empty">No accounts match.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="adm-hint">
        To replace a post holder (for example a new Budget Officer), add an account with the same type and deactivate the old one.
        Approval emails for DTMS signing are set in the “Approval flow” tab.
      </p>

      {editing && (
        <AccountForm
          meta={meta}
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); flash(msg); reload(); }}
        />
      )}
      {resetting && (
        <ResetPasswordForm
          account={resetting}
          onClose={() => setResetting(null)}
          onSaved={(msg) => { setResetting(null); flash(msg); reload(); }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Approval flow
// ---------------------------------------------------------------------------
const toText = (list) => (list || []).join('\n');
const stageForm = (s) => ({ signer: s?.signer || '', notify: toText(s?.notify) });

function flowToForm(flow) {
  return {
    HEAD: {
      default: stageForm(flow.ppmp.HEAD.default),
      offices: Object.fromEntries(Object.entries(flow.ppmp.HEAD.offices).map(([k, v]) => [k, stageForm(v)]))
    },
    TOD: stageForm(flow.ppmp.TOD),
    BO: stageForm(flow.ppmp.BO),
    ppmpRD: { notify: toText(flow.ppmp.RD?.notify) },
    app: { SUP: stageForm(flow.app.SUP), ARD: stageForm(flow.app.ARD), RD: stageForm(flow.app.RD) },
    completedPpmp: toText(flow.completed?.ppmp?.notify),
    completedApp: toText(flow.completed?.app?.notify),
    notifyRequester: flow.notifyRequester !== false
  };
}

function formToFlow(f) {
  return {
    ppmp: { HEAD: { default: f.HEAD.default, offices: f.HEAD.offices }, TOD: f.TOD, BO: f.BO, RD: { notify: f.ppmpRD.notify } },
    app: f.app,
    completed: { ppmp: { notify: f.completedPpmp }, app: { notify: f.completedApp } },
    notifyRequester: f.notifyRequester
  };
}

function StageFields({ title, note, value, onChange, signer = true, onRemove }) {
  return (
    <div className="adm-stage">
      <div className="adm-stage-head">
        <strong>{title}</strong>
        {onRemove && <button type="button" className="adm-link danger" onClick={onRemove}>Remove</button>}
      </div>
      {note && <p className="adm-hint">{note}</p>}
      <div className="adm-grid">
        {signer && (
          <label>
            <span>DTMS signer email</span>
            <input type="email" value={value.signer} onChange={(e) => onChange({ ...value, signer: e.target.value })} placeholder="name@dict.gov.ph" />
          </label>
        )}
        <label>
          <span>Notification emails</span>
          <textarea rows={2} value={value.notify} onChange={(e) => onChange({ ...value, notify: e.target.value })} placeholder="One per line, or separated by commas" />
        </label>
      </div>
    </div>
  );
}

function coverageChecks(accounts, form) {
  const active = accounts.filter((a) => a.active);
  const has = (type) => active.some((a) => a.type === type);
  const headOffices = new Set(active.filter((a) => a.type === 'unit_head').map((a) => norm(a.office)));
  const requesterOffices = [...new Set(active.filter((a) => ['requester', 'unit_head'].includes(a.type)).map((a) => a.office))];
  const noHead = requesterOffices.filter((o) => !headOffices.has(norm(o)));
  const configured = new Set(Object.keys(form.HEAD.offices).map(norm));
  const checks = [
    { ok: has('tod'), text: 'An active Technical Operations Division account exists' },
    { ok: has('bo'), text: 'An active Budget Officer account exists' },
    { ok: has('rd'), text: 'An active Regional Director account exists (final PPMP approval and APP)' },
    { ok: has('ard'), text: 'An active Assistant Regional Director account exists (APP)' },
    { ok: has('supply'), text: 'An active Supply account exists (submits the APP)' },
    { ok: noHead.length === 0, text: noHead.length ? `No active Unit Head for: ${noHead.join('; ')}` : 'Every office with requesters has an active Unit Head' }
  ];
  const unlisted = requesterOffices.filter((o) => !configured.has(norm(o)));
  if (unlisted.length) {
    checks.push({ ok: true, info: true, text: `Offices using the default Unit Head signer: ${unlisted.join('; ')}` });
  }
  return checks;
}

function FlowTab({ accounts, meta, flash }) {
  const [form, setForm] = useState(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [newOffice, setNewOffice] = useState('');
  const [testTo, setTestTo] = useState('');

  useEffect(() => {
    refreshFlow().then((flow) => setForm(flowToForm(flow))).catch((err) => setError(err.message));
  }, []);

  const setAt = (path, value) => setForm((f) => {
    const next = structuredClone(f);
    let target = next;
    path.slice(0, -1).forEach((key) => { target = target[key]; });
    target[path[path.length - 1]] = value;
    return next;
  });

  const addOffice = () => {
    const name = newOffice.trim().replace(/\s+/g, ' ');
    if (!name) return;
    if (Object.keys(form.HEAD.offices).some((o) => norm(o) === norm(name))) { setNewOffice(''); return; }
    setAt(['HEAD', 'offices', name], { signer: form.HEAD.default.signer, notify: '' });
    setNewOffice('');
  };
  const removeOffice = (name) => setForm((f) => {
    const next = structuredClone(f);
    delete next.HEAD.offices[name];
    return next;
  });

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await adminSaveFlow(formToFlow(form));
      setForm(flowToForm(res.flow));
      setVersion(res.version);
      await refreshFlow().catch(() => {});
      flash('Approval flow saved. New signatures and notifications use these emails right away.');
    } catch (err) {
      setError(err.message);
    }
    setSaving(false);
  };

  const sendTest = async () => {
    try {
      await adminTestEmail(testTo);
      flash(`Test email sent to ${testTo}.`);
    } catch (err) {
      flash(err.message, true);
    }
  };

  if (!form) return <p className="adm-hint">{error || 'Loading approval flow…'}</p>;
  const checks = coverageChecks(accounts, form);
  const officeOptions = meta.offices.filter((o) => !Object.keys(form.HEAD.offices).some((x) => norm(x) === norm(o)));

  return (
    <section className="adm-flow">
      {error && <div className="adm-error">{error}</div>}

      <div className="adm-card">
        <h3>Checks</h3>
        <ul className="adm-checks">
          {checks.map((c) => (
            <li key={c.text} className={c.info ? 'info' : c.ok ? 'ok' : 'warn'}>{c.info ? 'ℹ' : c.ok ? '✓' : '⚠'} {c.text}</li>
          ))}
        </ul>
      </div>

      <div className="adm-card">
        <h3>PPMP approval route</h3>
        <p className="adm-hint">
          Order: Unit Head → Technical Operations Division → Budget Officer → Regional Director.
          The first three sign in DTMS (the signer email must be an <b>active DTMS user</b>); the Regional Director approves in this system.
          Notification emails are told when a PPMP is waiting at that step.
        </p>
        <StageFields
          title="Unit Head – default"
          note="Used for any office that has no row below."
          value={form.HEAD.default}
          onChange={(v) => setAt(['HEAD', 'default'], v)}
        />
        {Object.keys(form.HEAD.offices).map((office) => (
          <StageFields
            key={office}
            title={`Unit Head – ${office}`}
            value={form.HEAD.offices[office]}
            onChange={(v) => setAt(['HEAD', 'offices', office], v)}
            onRemove={() => removeOffice(office)}
          />
        ))}
        <div className="adm-row adm-add-office">
          <input list="adm-flow-offices" placeholder="Add an office with its own Unit Head signer" value={newOffice} onChange={(e) => setNewOffice(e.target.value)} />
          <datalist id="adm-flow-offices">{officeOptions.map((o) => <option key={o} value={o} />)}</datalist>
          <button type="button" className="adm-btn" onClick={addOffice}>Add office</button>
        </div>
        <StageFields title="Technical Operations Division" value={form.TOD} onChange={(v) => setAt(['TOD'], v)} />
        <StageFields title="Budget Officer" value={form.BO} onChange={(v) => setAt(['BO'], v)} />
        <StageFields
          title="Regional Director (approves in the system)"
          signer={false}
          value={form.ppmpRD}
          onChange={(v) => setAt(['ppmpRD'], v)}
        />
      </div>

      <div className="adm-card">
        <h3>APP approval route</h3>
        <p className="adm-hint">Order: Supply → Assistant Regional Director → Regional Director. Every step signs in DTMS.</p>
        <StageFields title="Supply" value={form.app.SUP} onChange={(v) => setAt(['app', 'SUP'], v)} />
        <StageFields title="Assistant Regional Director" value={form.app.ARD} onChange={(v) => setAt(['app', 'ARD'], v)} />
        <StageFields title="Regional Director" value={form.app.RD} onChange={(v) => setAt(['app', 'RD'], v)} />
      </div>

      <div className="adm-card">
        <h3>Returned and approved notifications</h3>
        <label className="adm-check">
          <input type="checkbox" checked={form.notifyRequester} onChange={(e) => setAt(['notifyRequester'], e.target.checked)} />
          <span>Email the requesting office (PPMP) or Supply (APP) when a document is returned or approved</span>
        </label>
        <div className="adm-grid">
          <label>
            <span>Also email when a PPMP is approved</span>
            <textarea rows={2} value={form.completedPpmp} onChange={(e) => setAt(['completedPpmp'], e.target.value)} placeholder="One per line, or separated by commas" />
          </label>
          <label>
            <span>Also email when an APP becomes final</span>
            <textarea rows={2} value={form.completedApp} onChange={(e) => setAt(['completedApp'], e.target.value)} placeholder="One per line, or separated by commas" />
          </label>
        </div>
      </div>

      <div className="adm-card">
        <h3>Email delivery</h3>
        {meta.mailConfigured
          ? <p className="adm-hint">Email is set up on the server. Send yourself a test to confirm.</p>
          : <p className="adm-hint adm-warn">Email is not set up on the server yet (add the SMTP_* settings to server/.env). Notifications will be skipped until then; DTMS signing is not affected.</p>}
        <div className="adm-row">
          <input type="email" placeholder="you@dict.gov.ph" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <button type="button" className="adm-btn" onClick={sendTest} disabled={!testTo}>Send test email</button>
        </div>
      </div>

      <div className="adm-savebar">
        <span className="adm-hint">{version ? `Saved as version ${version}.` : 'Changes are not applied until you save.'}</span>
        <button type="button" className="adm-btn adm-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save approval flow'}</button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------
function ActivityTab() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    adminAudit().then((r) => setEntries(r.entries)).catch((err) => setError(err.message));
  }, []);
  if (error) return <div className="adm-error">{error}</div>;
  if (!entries) return <p className="adm-hint">Loading…</p>;
  return (
    <section className="adm-table-wrap">
      <table className="adm-table">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.at}-${i}`}>
              <td>{new Date(e.at).toLocaleString()}</td>
              <td>{e.by}</td>
              <td>{e.action}</td>
              <td>{e.detail}</td>
            </tr>
          ))}
          {entries.length === 0 && <tr><td colSpan={4} className="adm-empty">No changes recorded yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function Admin() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [tab, setTab] = useState('accounts');
  const [meta, setMeta] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState(null);

  const flash = useCallback((message, isError = false) => {
    setToast({ message, isError });
    setTimeout(() => setToast((t) => (t && t.message === message ? null : t)), 8000);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([adminMeta(), adminListAccounts()]);
      setMeta(m);
      setAccounts(a.accounts);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="adm-page">
      <header className="adm-header">
        <div>
          <h1>DICT Procurement – Administration</h1>
          <p>Signed in as {user.email}</p>
        </div>
        <div className="adm-row">
          <button type="button" className="adm-btn" onClick={toggleTheme}>{theme === 'dark' ? '☀️' : '🌙'}</button>
          <button type="button" className="adm-btn" onClick={() => { logout(); navigate('/login'); }}>Sign out</button>
        </div>
      </header>

      <nav className="adm-tabs" role="tablist">
        {[['accounts', 'Accounts'], ['flow', 'Approval flow'], ['activity', 'Activity log']].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>

      {toast && <div className={`adm-toast ${toast.isError ? 'error' : ''}`} role="status">{toast.message}</div>}
      {loadError && <div className="adm-error">{loadError} <button type="button" className="adm-link" onClick={reload}>Retry</button></div>}

      <main className="adm-main">
        {meta && tab === 'accounts' && <AccountsTab accounts={accounts} meta={meta} me={user} reload={reload} flash={flash} />}
        {meta && tab === 'flow' && <FlowTab accounts={accounts} meta={meta} flash={flash} />}
        {tab === 'activity' && <ActivityTab />}
      </main>
    </div>
  );
}
