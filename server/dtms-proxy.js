// Small proxy between the PPMP web app (and the index.html tester) and the DTMS Public API.
// Why: the DTMS key must never be in browser code, and DTMS checks the Origin header,
// which a server can set but a browser page cannot.
// Run:  npm start        (Node 20.6+)
import express from 'express';
import multer from 'multer';

const {
  DTMS_BASE_URL, DTMS_API_KEY, DTMS_ORIGIN, PORT = 3001,
  APP_ORIGIN = 'http://localhost:3000',
  APP_ORIGINS = '',
  TESTER_ORIGIN = 'http://127.0.0.1:5500'   // where Live Server opens index.html
} = process.env;
if (!DTMS_BASE_URL || !DTMS_API_KEY || !DTMS_ORIGIN) {
  console.error('Missing DTMS_BASE_URL, DTMS_API_KEY or DTMS_ORIGIN in .env');
  process.exit(1);
}
const BASE = DTMS_BASE_URL.replace(/\/?$/, '/') + 'document/public/';
console.log('Sending origin:', JSON.stringify(DTMS_ORIGIN));
const dtmsHeaders = { 'X-API-Token': DTMS_API_KEY, Origin: DTMS_ORIGIN };
const ALLOWED = new Set(
  [APP_ORIGIN, APP_ORIGINS, TESTER_ORIGIN]
    .flatMap((origins) => origins.split(','))
    .map((origin) => origin.trim())
    .filter(Boolean)
);
console.log('Allowed browser origins:', [...ALLOWED].join(', '));

const app = express();

// Log every request
app.use((req, res, next) => {
  console.log(new Date().toLocaleTimeString(), req.method, req.url);
  res.on('finish', () => console.log('  ->', res.statusCode));
  next();
});

// Only your own web app and the tester page may call this proxy.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 20 } });

async function forward(res, url, options = {}) {
  try {
    const r = await fetch(url, { ...options, headers: { ...dtmsHeaders, ...(options.headers || {}) } });
    res.status(r.status);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    const cd = r.headers.get('content-disposition');
    if (cd) res.setHeader('Content-Disposition', cd);
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status >= 400) console.log('  DTMS said:', buf.toString().slice(0, 400));
    res.send(buf);
  } catch (e) {
    res.status(502).json({ detail: 'Cannot reach DTMS: ' + e.message });
  }
}

// ---- Used by the PPMP app (dtmsClient.js) ----
app.post('/api/dtms/submit', upload.fields([{ name: 'files' }, { name: 'supporting_files' }]), (req, res) => {
  const form = new FormData();
  for (const k of ['title', 'requestor', 'position', 'message', 'signatories']) {
    if (req.body[k] != null) form.append(k, req.body[k]);
  }
  for (const field of ['files', 'supporting_files']) {
    for (const f of req.files?.[field] || []) {
      form.append(field, new Blob([f.buffer], { type: 'application/pdf' }), f.originalname);
    }
  }
  forward(res, BASE + 'submit/', { method: 'POST', body: form });
});

app.get('/api/dtms/signatories', (req, res) =>
  forward(res, BASE + 'signatories/?' + new URLSearchParams(req.query)));

app.get('/api/dtms/status/:track', (req, res) =>
  forward(res, BASE + 'documents/' + encodeURIComponent(req.params.track) + '/'));

app.get('/api/dtms/files/:track/:id', (req, res) =>
  forward(res, BASE + `documents/${encodeURIComponent(req.params.track)}/files/${encodeURIComponent(req.params.id)}/?inline=1`));

// ---- Used by the index.html tester ----
// In the tester set API base URL to  http://localhost:3001/api/v1/
// Requests to /api/v1/document/public/... are passed on to DTMS with the key and origin
// from .env (whatever key the tester sends is ignored). Development use only.
app.use('/api/v1/document/public', express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
  const rest = req.originalUrl.replace(/^\/api\/v1\/document\/public\/?/, '');
  const headers = {};
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length;
  forward(res, BASE + rest, { method: req.method, headers, body: hasBody ? req.body : undefined });
});

app.listen(PORT, () => console.log(`DTMS proxy on http://localhost:${PORT} -> ${BASE}`));