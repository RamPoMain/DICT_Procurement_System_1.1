// Accounts, sign-in, approval-flow settings and e-mail notifications.
// Mounted by dtms-proxy.js:  app.use('/api', createApiRouter());
// Built-ins only (express + node:crypto). e-mail needs the optional `nodemailer` package.
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const cleanEmail = (v) => {
  const e = String(v ?? '').trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
};
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Account types. Flags are derived from the type, never stored, so changing a
// type always gives consistent permissions.
// ---------------------------------------------------------------------------
export const ACCOUNT_TYPES = {
  requester: {
    label: 'Requesting office', needsOffice: true, editableRole: true,
    build: (a) => ({ role: a.role, canRequest: true, canApprove: false })
  },
  unit_head: {
    label: 'Unit Head', needsOffice: true, editableRole: true,
    build: (a) => ({ role: a.role, canRequest: true, canApprove: true, stage: 'HEAD', headOf: a.office })
  },
  tod: {
    label: 'Technical Operations Division', fixedRole: 'TOD', defaultOffice: 'Technical Operations Division',
    build: () => ({ role: 'TOD', canApprove: true, stage: 'TOD' })
  },
  bo: {
    label: 'Budget Officer', fixedRole: 'BO', defaultOffice: 'Budget Office',
    build: () => ({ role: 'BO', canApprove: true, stage: 'BO' })
  },
  ard: {
    label: 'Assistant Regional Director', fixedRole: 'ARD',
    build: () => ({ role: 'ARD', canApprove: true, stage: 'RD' })
  },
  rd: {
    label: 'Regional Director', fixedRole: 'RD',
    build: () => ({ role: 'RD', canApprove: true, stage: 'RD' })
  },
  supply: {
    label: 'Supply', fixedRole: 'SUP',
    build: () => ({ role: 'SUP', canRequest: false, canApprove: false, canTrackApprovals: true })
  },
  admin: {
    label: 'Administrator', fixedRole: 'ADMIN',
    build: () => ({ role: 'ADMIN', canAdmin: true, canRequest: false, canApprove: false })
  }
};

const STAGE_LABELS = {
  HEAD: 'Unit Head', TOD: 'Technical Operations Division', BO: 'Budget Officer',
  SUP: 'Supply', ARD: 'Assistant Regional Director', RD: 'Regional Director'
};
const PPMP_STAGES = ['HEAD', 'TOD', 'BO', 'RD'];
const APP_STAGES = ['SUP', 'ARD', 'RD'];

function toUser(acct) {
  const t = ACCOUNT_TYPES[acct.type] || ACCOUNT_TYPES.requester;
  return {
    id: acct.id,
    email: acct.email,
    type: acct.type,
    roleName: acct.roleName,
    office: acct.office || t.defaultOffice || '',
    active: acct.active !== false,
    mustChangePassword: !!acct.mustChangePassword,
    ...t.build(acct)
  };
}

// ---------------------------------------------------------------------------
// Seed data (the accounts that used to be hard-coded in AuthContext.jsx)
// ---------------------------------------------------------------------------
const ILCDB = 'ICT Literacy Competency and Development bureau';
const FPIAP = 'Free Public Internet Access Program';
const GASS = 'General Administration and Support Services';
const SEED_ACCOUNTS = [
  { email: 'ILCDB@dict.gov.ph', type: 'requester', role: 'ILCDB', roleName: 'ILCDB', office: ILCDB },
  { email: 'FPIAP@dict.gov.ph', type: 'requester', role: 'FPIAP', roleName: 'FPIAP', office: FPIAP },
  { email: 'GASS@dict.gov.ph', type: 'requester', role: 'GASS', roleName: 'GASS', office: GASS },
  { email: 'FPIAPHEAD@dict.gov.ph', type: 'unit_head', role: 'FPIAPH', roleName: 'FPIAP Head', office: FPIAP },
  { email: 'ILCDBHEAD@dict.gov.ph', type: 'unit_head', role: 'ILCDBH', roleName: 'ILCDB Head', office: ILCDB },
  { email: 'GASSHEAD@dict.gov.ph', type: 'unit_head', role: 'GASSH', roleName: 'GASS Head', office: GASS },
  { email: 'tod@dict.gov.ph', type: 'tod', roleName: 'Technical Operations Division', office: 'Technical Operations Division' },
  { email: 'BudgetOfficer@dict.gov.ph', type: 'bo', roleName: 'Budget Officer', office: 'Budget Office' },
  { email: 'ard@dict.gov.ph', type: 'ard', roleName: 'Assistant Regional Director' },
  { email: 'rd@dict.gov.ph', type: 'rd', roleName: 'Regional Director' },
  { email: 'supply@dict.gov.ph', type: 'supply', roleName: 'Supply' },
  { email: 'test@dict.gov.ph', type: 'requester', role: 'POP', roleName: 'POP (Test Account)', office: 'POP Test Office' }
];

// Same signer addresses that were hard-coded in dtmsClient.js (placeholders: change them in the Admin page).
const PLACEHOLDER_SIGNER = '20210022244@my.xu.edu.ph';
const defaultFlow = () => ({
  ppmp: {
    HEAD: {
      default: { signer: PLACEHOLDER_SIGNER, notify: [] },
      offices: {
        'ICT Literacy Competency and Development bureau': { signer: PLACEHOLDER_SIGNER, notify: [] },
        'Free Public Wi-Fi and Broadband Infrastructure bureau': { signer: PLACEHOLDER_SIGNER, notify: [] }
      }
    },
    TOD: { signer: PLACEHOLDER_SIGNER, notify: [] },
    BO: { signer: PLACEHOLDER_SIGNER, notify: [] },
    RD: { notify: [] }
  },
  app: {
    SUP: { signer: PLACEHOLDER_SIGNER, notify: [] },
    ARD: { signer: PLACEHOLDER_SIGNER, notify: [] },
    RD: { signer: PLACEHOLDER_SIGNER, notify: [] }
  },
  completed: { ppmp: { notify: [] }, app: { notify: [] } },
  notifyRequester: true
});

// ---------------------------------------------------------------------------
// Passwords and tokens
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const test = crypto.scryptSync(password, salt, 64);
    const real = Buffer.from(hash, 'hex');
    return real.length === test.length && crypto.timingSafeEqual(real, test);
  } catch {
    return false;
  }
}
const DUMMY_HASH = hashPassword('not-a-real-password');

let store = null;
const b64 = (buf) => Buffer.from(buf).toString('base64url');
function signToken(accountId) {
  const body = b64(JSON.stringify({ sub: accountId, exp: Date.now() + TOKEN_TTL_MS }));
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}
const getSecret = () => process.env.SESSION_SECRET || store.secret;

// ---------------------------------------------------------------------------
// Storage (one JSON file, written atomically)
// ---------------------------------------------------------------------------
function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function initStore() {
  try {
    store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    store = null;
  }
  if (store && Array.isArray(store.accounts)) {
    if (!store.secret) { store.secret = crypto.randomBytes(32).toString('hex'); saveStore(); }
    return;
  }

  const seedPw = process.env.SEED_PASSWORD || '1';
  if (!process.env.SEED_PASSWORD) {
    console.warn('[admin] SEED_PASSWORD is not set: seeded accounts start with the temporary password "1" and must change it at first sign-in.');
  }
  const now = Date.now();
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@dict.gov.ph').trim().toLowerCase();
  const make = (a) => ({
    id: a.email.toLowerCase(),
    email: a.email,
    type: a.type,
    role: a.role || ACCOUNT_TYPES[a.type].fixedRole,
    roleName: a.roleName,
    office: a.office || '',
    passwordHash: hashPassword(a.password || seedPw),
    active: true,
    mustChangePassword: true,
    createdAt: now,
    updatedAt: now
  });
  store = {
    secret: crypto.randomBytes(32).toString('hex'),
    version: 1,
    accounts: [
      ...SEED_ACCOUNTS.map(make),
      make({ email: adminEmail, type: 'admin', roleName: 'Administrator', password: process.env.ADMIN_PASSWORD || seedPw })
    ],
    flow: defaultFlow(),
    audit: []
  };
  saveStore();
  console.log(`[admin] Created ${STORE_FILE} with ${store.accounts.length} accounts. Administrator: ${adminEmail}`);
}

function audit(by, action, detail) {
  store.audit.unshift({ at: Date.now(), by: by?.email || 'system', action, detail: detail || '' });
  store.audit.length = Math.min(store.audit.length, 300);
}

// ---------------------------------------------------------------------------
// Flow validation
// ---------------------------------------------------------------------------
function parseEmailList(v, label, errors) {
  const parts = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  const out = [];
  for (const raw of parts) {
    const t = String(raw).trim();
    if (!t) continue;
    const e = cleanEmail(t);
    if (!e) errors.push(`${label}: "${t}" is not a valid email address.`);
    else if (!out.includes(e)) out.push(e);
  }
  if (out.length > 20) errors.push(`${label}: at most 20 emails.`);
  return out.slice(0, 20);
}
function parseSigner(v, label, errors, required) {
  const t = String(v || '').trim();
  if (!t) {
    if (required) errors.push(`${label}: a DTMS signer email is required.`);
    return '';
  }
  const e = cleanEmail(t);
  if (!e) { errors.push(`${label}: signer "${t}" is not a valid email address.`); return ''; }
  return e;
}
function parseStage(input, label, errors, withSigner) {
  const out = { notify: parseEmailList(input?.notify, `${label} notifications`, errors) };
  if (withSigner) out.signer = parseSigner(input?.signer, label, errors, true);
  return out;
}
function sanitizeFlow(input, errors) {
  const p = input?.ppmp || {};
  const a = input?.app || {};
  const offices = {};
  Object.entries(p.HEAD?.offices || {}).slice(0, 100).forEach(([name, cfg]) => {
    const key = String(name).trim().replace(/\s+/g, ' ');
    if (!key || UNSAFE_KEYS.has(key)) return;
    offices[key] = parseStage(cfg, `Unit Head – ${key}`, errors, true);
  });
  return {
    ppmp: {
      HEAD: { default: parseStage(p.HEAD?.default, 'Unit Head (default)', errors, true), offices },
      TOD: parseStage(p.TOD, 'Technical Operations Division', errors, true),
      BO: parseStage(p.BO, 'Budget Officer', errors, true),
      RD: parseStage(p.RD, 'Regional Director (PPMP)', errors, false)
    },
    app: {
      SUP: parseStage(a.SUP, 'APP – Supply', errors, true),
      ARD: parseStage(a.ARD, 'APP – Assistant Regional Director', errors, true),
      RD: parseStage(a.RD, 'APP – Regional Director', errors, true)
    },
    completed: {
      ppmp: { notify: parseEmailList(input?.completed?.ppmp?.notify, 'PPMP approved notifications', errors) },
      app: { notify: parseEmailList(input?.completed?.app?.notify, 'APP final notifications', errors) }
    },
    notifyRequester: input?.notifyRequester !== false
  };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------
let transportPromise = null;
function getTransport() {
  if (transportPromise) return transportPromise;
  transportPromise = (async () => {
    if (!process.env.SMTP_HOST) return null;
    try {
      const { default: nodemailer } = await import('nodemailer');
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
      });
    } catch {
      console.warn('[mail] SMTP_HOST is set but the "nodemailer" package is not installed. Run: npm --prefix server install nodemailer');
      return null;
    }
  })();
  return transportPromise;
}

async function sendMail(recipients, subject, text, html) {
  const to = [...new Set(recipients)];
  if (!to.length) return { sent: 0, skipped: 'no-recipients' };
  const transport = await getTransport();
  if (!transport) {
    console.log(`[mail] (not configured) would send "${subject}" to ${to.join(', ')}`);
    return { sent: 0, skipped: 'mail-not-configured' };
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const results = await Promise.allSettled(to.map((address) => transport.sendMail({ from, to: address, subject, text, html })));
  const failed = results.filter((r) => r.status === 'rejected');
  failed.forEach((r) => console.warn('[mail] failed:', r.reason?.message || r.reason));
  return { sent: results.length - failed.length, failed: failed.length };
}

function recipientsFor({ kind, event, stage, record }) {
  const flow = store.flow;
  const set = new Set();
  const add = (list) => (list || []).forEach((e) => set.add(e));
  const office = norm(record.end_user);

  if (event === 'arrived') {
    if (kind === 'ppmp' && stage === 'HEAD') {
      const hit = Object.entries(flow.ppmp.HEAD.offices).find(([name]) => norm(name) === office)?.[1];
      add((hit || flow.ppmp.HEAD.default).notify);
    } else {
      add((kind === 'ppmp' ? flow.ppmp : flow.app)[stage]?.notify);
    }
  } else {
    if (flow.notifyRequester) {
      store.accounts
        .filter((a) => a.active !== false)
        .filter((a) => (kind === 'ppmp'
          ? ['requester', 'unit_head'].includes(a.type) && norm(a.office) === office
          : a.type === 'supply'))
        .forEach((a) => set.add(a.email.toLowerCase()));
    }
    if (event === 'final') add(flow.completed[kind]?.notify);
  }
  return [...set];
}

function buildMessage({ kind, event, stage, record, remarks }) {
  const what = kind === 'ppmp' ? `PPMP ${record.ppmp_no || ''}`.trim() : `APP FY ${record.fiscal_year || ''}`.trim();
  const stageLabel = STAGE_LABELS[stage] || stage || '';
  let subject;
  let line;
  if (event === 'arrived') {
    subject = `[DICT Procurement] ${what} is waiting for ${stageLabel}`;
    line = `${what} is now waiting for ${stageLabel}.`;
  } else if (event === 'returned') {
    subject = `[DICT Procurement] ${what} was returned for revision`;
    line = `${what} was returned for revision.`;
  } else {
    subject = `[DICT Procurement] ${what} is approved`;
    line = `${what} is fully approved.`;
  }
  const rows = [
    kind === 'ppmp' && record.end_user ? ['Office', record.end_user] : null,
    record.fiscal_year ? ['Fiscal year', record.fiscal_year] : null,
    remarks ? ['Remarks', remarks] : null
  ].filter(Boolean);
  const url = process.env.APP_PUBLIC_URL || process.env.APP_ORIGIN || '';
  const text = [line, '', ...rows.map(([k, v]) => `${k}: ${v}`), url ? `\nOpen the system: ${url}` : ''].join('\n');
  const html = `<p>${esc(line)}</p><table cellpadding="4">${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>${url ? `<p><a href="${esc(url)}">Open the system</a></p>` : ''}`;
  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export function createApiRouter() {
  initStore();
  const router = express.Router();
  const json = express.json({ limit: '100kb' });

  // CORS for these routes only (adds Authorization + PUT/PATCH; /api/dtms keeps its own rules).
  const allowed = new Set([
    process.env.APP_ORIGIN,
    ...String(process.env.APP_ORIGINS || '').split(',')
  ].map((o) => String(o || '').trim().replace(/\/$/, '')).filter(Boolean));
  router.use(['/auth', '/admin', '/flow', '/notify'], (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  // --- auth helpers
  const auth = (req, res, next) => {
    const header = String(req.headers.authorization || '');
    const payload = readToken(header.startsWith('Bearer ') ? header.slice(7) : '');
    const acct = payload && store.accounts.find((a) => a.id === payload.sub);
    if (!acct || acct.active === false) return res.status(401).json({ error: 'Please sign in again.' });
    req.account = acct;
    return next();
  };
  const adminOnly = (req, res, next) => (
    req.account.type === 'admin' ? next() : res.status(403).json({ error: 'Administrator access required.' })
  );

  // --- login (with a small brute-force lock)
  const attempts = new Map();
  router.post('/auth/login', json, (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const key = `${req.ip}|${email}`;
    const state = attempts.get(key);
    if (state && state.until > Date.now()) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    const acct = store.accounts.find((a) => a.email.toLowerCase() === email);
    const ok = verifyPassword(password, acct ? acct.passwordHash : DUMMY_HASH) && acct && acct.active !== false;
    if (!ok) {
      const count = (state?.count || 0) + 1;
      attempts.set(key, { count, until: count >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    attempts.delete(key);
    return res.json({ token: signToken(acct.id), user: toUser(acct) });
  });

  router.get('/auth/me', auth, (req, res) => res.json({ user: toUser(req.account) }));

  router.post('/auth/change-password', auth, json, (req, res) => {
    const { current, next } = req.body || {};
    if (!verifyPassword(String(current || ''), req.account.passwordHash)) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    if (String(next || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    if (next === current) return res.status(400).json({ error: 'Choose a different password.' });
    req.account.passwordHash = hashPassword(String(next));
    req.account.mustChangePassword = false;
    req.account.updatedAt = Date.now();
    audit(req.account, 'password.change', req.account.email);
    saveStore();
    return res.json({ user: toUser(req.account) });
  });

  // --- flow (any signed-in user reads it; the app needs the signer emails)
  router.get('/flow', auth, (req, res) => res.json({ flow: store.flow, version: store.version }));

  // --- admin: meta + accounts
  router.get('/admin/meta', auth, adminOnly, (req, res) => {
    const offices = new Set(store.accounts.map((a) => a.office).filter(Boolean));
    Object.keys(store.flow.ppmp.HEAD.offices).forEach((o) => offices.add(o));
    res.json({
      types: Object.entries(ACCOUNT_TYPES).map(([key, t]) => ({
        key, label: t.label, needsOffice: !!t.needsOffice, editableRole: !!t.editableRole, fixedRole: t.fixedRole || null
      })),
      offices: [...offices].sort((x, y) => x.localeCompare(y)),
      stageLabels: STAGE_LABELS,
      mailConfigured: !!process.env.SMTP_HOST
    });
  });

  router.get('/admin/accounts', auth, adminOnly, (req, res) => {
    res.json({ accounts: store.accounts.map((a) => ({ ...toUser(a), createdAt: a.createdAt, updatedAt: a.updatedAt })) });
  });

  function readAccountFields(body, existing, errors) {
    const type = body.type ?? existing?.type;
    const t = ACCOUNT_TYPES[type];
    if (!t) { errors.push('Choose an account type.'); return null; }
    const email = cleanEmail(body.email ?? existing?.email);
    if (!email) errors.push('Enter a valid email address.');
    else if (store.accounts.some((a) => a.id !== existing?.id && a.email.toLowerCase() === email)) errors.push('That email is already used by another account.');
    const roleName = String(body.roleName ?? existing?.roleName ?? '').trim();
    if (!roleName) errors.push('Enter a display name.');
    const office = String(body.office ?? existing?.office ?? '').trim();
    if (t.needsOffice && !office) errors.push('Enter the office for this account.');
    let role = t.fixedRole;
    if (t.editableRole) {
      role = String(body.role ?? existing?.role ?? '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
      if (!role) errors.push('Enter a role code (letters and numbers, e.g. ILCDB).');
      if (['ADMIN', 'SUP', 'ARD', 'RD', 'TOD', 'BO', 'HEAD'].includes(role)) errors.push(`"${role}" is reserved for a fixed role.`);
    }
    return errors.length ? null : { type, email, roleName, office: office || t.defaultOffice || '', role };
  }

  const activeAdmins = (excludeId) => store.accounts.filter((a) => a.type === 'admin' && a.active !== false && a.id !== excludeId).length;

  router.post('/admin/accounts', auth, adminOnly, json, (req, res) => {
    const errors = [];
    const fields = readAccountFields(req.body || {}, null, errors);
    const password = String(req.body?.password || '');
    if (password.length < 8) errors.push('Password must be at least 8 characters.');
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const now = Date.now();
    const acct = {
      id: fields.email, ...fields, passwordHash: hashPassword(password),
      active: true, mustChangePassword: true, createdAt: now, updatedAt: now
    };
    if (store.accounts.some((a) => a.id === acct.id)) acct.id = `${fields.email}#${now}`;
    store.accounts.push(acct);
    audit(req.account, 'account.create', `${acct.email} (${acct.type})`);
    saveStore();
    return res.status(201).json({ account: toUser(acct) });
  });

  router.patch('/admin/accounts/:id', auth, adminOnly, json, (req, res) => {
    const acct = store.accounts.find((a) => a.id === req.params.id);
    if (!acct) return res.status(404).json({ error: 'Account not found.' });
    const body = req.body || {};
    const isSelf = acct.id === req.account.id;
    const errors = [];
    const fields = readAccountFields(body, acct, errors);
    if (!fields) return res.status(400).json({ error: errors.join(' ') });

    const nextActive = body.active === undefined ? acct.active !== false : !!body.active;
    if (isSelf && (!nextActive || fields.type !== 'admin')) {
      return res.status(400).json({ error: 'You cannot deactivate or demote your own administrator account.' });
    }
    const losesAdmin = acct.type === 'admin' && acct.active !== false && (!nextActive || fields.type !== 'admin');
    if (losesAdmin && activeAdmins(acct.id) === 0) {
      return res.status(400).json({ error: 'There must be at least one active administrator.' });
    }

    const changes = [];
    if (acct.email !== fields.email) changes.push(`email ${acct.email} → ${fields.email}`);
    if (acct.type !== fields.type) changes.push(`type ${acct.type} → ${fields.type}`);
    if (acct.office !== fields.office) changes.push(`office → ${fields.office || '(none)'}`);
    if ((acct.active !== false) !== nextActive) changes.push(nextActive ? 'activated' : 'deactivated');
    Object.assign(acct, fields, { active: nextActive, updatedAt: Date.now() });
    audit(req.account, 'account.update', `${acct.email}: ${changes.join('; ') || 'details updated'}`);
    saveStore();
    return res.json({ account: toUser(acct) });
  });

  router.post('/admin/accounts/:id/reset-password', auth, adminOnly, json, (req, res) => {
    const acct = store.accounts.find((a) => a.id === req.params.id);
    if (!acct) return res.status(404).json({ error: 'Account not found.' });
    const password = String(req.body?.password || '');
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    acct.passwordHash = hashPassword(password);
    acct.mustChangePassword = true;
    acct.updatedAt = Date.now();
    audit(req.account, 'account.reset-password', acct.email);
    saveStore();
    return res.json({ ok: true });
  });

  // --- admin: flow
  router.put('/admin/flow', auth, adminOnly, json, (req, res) => {
    const errors = [];
    const flow = sanitizeFlow(req.body?.flow, errors);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    store.flow = flow;
    store.version += 1;
    audit(req.account, 'flow.update', `version ${store.version}`);
    saveStore();
    return res.json({ flow: store.flow, version: store.version });
  });

  router.get('/admin/audit', auth, adminOnly, (req, res) => res.json({ entries: store.audit.slice(0, 100) }));

  router.post('/admin/test-email', auth, adminOnly, json, async (req, res) => {
    const to = cleanEmail(req.body?.to);
    if (!to) return res.status(400).json({ error: 'Enter a valid email address.' });
    const result = await sendMail([to], '[DICT Procurement] Test email', 'This is a test email from the DICT Procurement system.', '<p>This is a test email from the DICT Procurement system.</p>');
    if (result.skipped === 'mail-not-configured') {
      return res.status(400).json({ error: 'Email is not set up on the server yet (SMTP_* settings in server/.env).' });
    }
    return res.json(result);
  });

  // --- notifications (recipients always come from the saved flow, never from the browser)
  const notifyLog = new Map(); // dedupe: key -> time
  const notifyRate = new Map(); // account id -> [times]
  router.post('/notify', auth, json, async (req, res) => {
    const { kind, event, stage } = req.body || {};
    const record = req.body?.record || {};
    if (!['ppmp', 'app'].includes(kind) || !['arrived', 'returned', 'final'].includes(event)) {
      return res.status(400).json({ error: 'Unknown notification.' });
    }
    if (event === 'arrived' && !(kind === 'ppmp' ? PPMP_STAGES : APP_STAGES).includes(stage)) {
      return res.status(400).json({ error: 'Unknown stage.' });
    }
    const hour = Date.now() - 60 * 60 * 1000;
    const recent = (notifyRate.get(req.account.id) || []).filter((t) => t > hour);
    if (recent.length >= 60) return res.status(429).json({ error: 'Too many notifications.' });
    recent.push(Date.now());
    notifyRate.set(req.account.id, recent);

    const clean = {
      ppmp_no: String(record.ppmp_no || '').slice(0, 60),
      end_user: String(record.end_user || '').slice(0, 200),
      fiscal_year: String(record.fiscal_year || '').slice(0, 10)
    };
    const dedupeKey = [kind, event, stage || '', clean.ppmp_no || clean.fiscal_year, clean.end_user, req.body?.round || ''].join('|');
    const last = notifyLog.get(dedupeKey);
    if (last && Date.now() - last < 10 * 60 * 1000) return res.json({ ok: true, skipped: 'duplicate' });
    notifyLog.set(dedupeKey, Date.now());
    if (notifyLog.size > 500) notifyLog.delete(notifyLog.keys().next().value);

    const recipients = recipientsFor({ kind, event, stage, record: clean });
    const message = buildMessage({ kind, event, stage, record: clean, remarks: String(req.body?.remarks || '').slice(0, 500) });
    try {
      const result = await sendMail(recipients, message.subject, message.text, message.html);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.warn('[notify] failed:', err?.message || err);
      return res.json({ ok: false });
    }
  });

  return router;
}
