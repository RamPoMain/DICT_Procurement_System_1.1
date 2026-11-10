// DTMS integration for the PPMP app. Talks to server/dtms-proxy.js, never to DTMS directly.
import { APPROVAL_CHAIN, getEffectiveApprovalChain, getPpmpStatus, recordApprovedPpmpNumber, isHeadStepSkipped, getPpmpSubmitError, submitPpmpForApproval } from './procurementRules.js';
import { buildPPMP_PDF_Blob, previewAPP_PDF } from './pdfGenerator.js';

const PROXY = import.meta.env?.VITE_DTMS_PROXY || 'http://localhost:3001/api/dtms';

// ---------------------------------------------------------------------------
// DTMS signatories, kept SEPARATE per document type so PPMP and APP
// approvers/reviewers/signers never conflict with each other.
// Emails must be ACTIVE DTMS users.
// ---------------------------------------------------------------------------

// DTMS role used for each document type:
//   'reviewer' = approve/decline only
//   'signer'   = DTMS puts a digital signature on the PDF
export const DTMS_ROLE = {
  PPMP: 'reviewer',
  APP: 'reviewer'
};

// PPMP chain. HEAD depends on the office (record.end_user); the rest are fixed.
// Keys must match the `role` values in APPROVAL_CHAIN.
export const PPMP_SIGNERS = {
  HEAD: {
    'ICT Literacy Competency and Development bureau': '20210022244@my.xu.edu.ph'
  }, // office -> email
  TOD: '20210022244@my.xu.edu.ph',
  BO: '20210022244@my.xu.edu.ph',
  RD: '20210022244@my.xu.edu.ph'
};

// APP chain, in signing order. Edit this list freely without touching PPMP.
export const APP_SIGNERS = [
  { key: 'APP_ARD', email: '20210022244@my.xu.edu.ph' },
  { key: 'RD', email: '20210022244@my.xu.edu.ph' }
];

const normalizeOffice = (office) => String(office || '').trim().replace(/\s+/g, ' ').toLowerCase();

// skipHead: pass true when the Unit Head is the one submitting. The record is not marked as
// submitted yet at that point (DTMS is called first), so the caller must say so explicitly.
// Without the option, it is read from the record (already submitted by the Unit Head).
export function buildSignatories(record, { skipHead = isHeadStepSkipped(record) } = {}) {
  // When the Unit Head submitted, HEAD is not in the chain, so no Unit Head email is needed.
  const chain = skipHead ? APPROVAL_CHAIN.filter((step) => step.role !== 'HEAD') : APPROVAL_CHAIN;
  let headEmail;
  if (!skipHead) {
    const office = normalizeOffice(record.end_user);
    headEmail = Object.entries(PPMP_SIGNERS.HEAD)
      .find(([name]) => normalizeOffice(name) === office)?.[1];
    if (!headEmail) throw new Error(`No DTMS email configured for the Unit Head of "${record.end_user}".`);
  }

  const emailFor = { HEAD: headEmail, TOD: PPMP_SIGNERS.TOD, BO: PPMP_SIGNERS.BO, RD: PPMP_SIGNERS.RD };
  return chain.map((step, i) => {
    const email = emailFor[step.role];
    if (!email) throw new Error(`No DTMS email configured for PPMP step "${step.role}".`);
    return { email, role: DTMS_ROLE.PPMP, order: i };
  });
}

export function buildAppSignatories() {
  const missing = APP_SIGNERS.filter((s) => !s.email).map((s) => s.key);
  if (missing.length) throw new Error(`DTMS APP signatories not configured: ${missing.join(', ')}.`);
  return APP_SIGNERS.map((s, i) => ({ email: s.email, role: DTMS_ROLE.APP, order: i }));
}

async function asJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.detail || (body.errors && Object.entries(body.errors).map(([k, v]) => `${k}: ${v}`).join('; ')) || res.statusText;
    throw new Error(`DTMS ${res.status}: ${detail}`);
  }
  return body;
}

export async function submitPpmpToDtms(record, session) {
  const pdf = await buildPPMP_PDF_Blob(record);
  const form = new FormData();
  form.append('title', `PPMP No. ${record.ppmp_no} — ${record.end_user}`.slice(0, 100));
  form.append('requestor', (session?.roleName || record.submitted_by?.name || 'PPMP System').slice(0, 100));
  form.append('position', (session?.role || 'Unit').slice(0, 100));
  form.append('message', `PPMP No. ${record.ppmp_no} (FY ${record.fiscal_year}) of ${record.end_user} for approval.`);
  form.append('signatories', JSON.stringify(buildSignatories(record, { skipHead: session?.stage === 'HEAD' })));
  form.append('files', pdf, `PPMP_${record.ppmp_no}.pdf`);
  const out = await asJson(await fetch(`${PROXY}/submit`, { method: 'POST', body: form }));
  return { tracknumber: out.tracknumber, submitted_at: Date.now() };
}

// ONE way to submit a PPMP, used by the Request modal and the Entries table:
//   1) validate locally  2) send to DTMS  3) mark For Approval and save dtms_track in a single write.
// Nothing is sent to DTMS when validation fails, and the status and tracking number are saved together.
const submitsInFlight = new Set(); // stops a double click from creating two DTMS documents
export async function submitPpmpViaDtms(recordId, session) {
  if (!session) return { success: false, error: 'Not authenticated.' };
  if (submitsInFlight.has(recordId)) return { success: false, error: 'This PPMP is already being submitted.' };
  submitsInFlight.add(recordId);
  try {
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const record = all.find((r) => r.id === recordId);
    if (!record) return { success: false, error: 'Record not found.' };

    const problem = getPpmpSubmitError(record);
    if (problem) return { success: false, error: problem };

    let dtms;
    try {
      dtms = await submitPpmpToDtms(record, session);
    } catch (e) {
      return { success: false, error: e.message }; // nothing changed locally
    }

    const res = submitPpmpForApproval(recordId, session, { dtms_track: dtms.tracknumber });
    if (!res.success) {
      return { success: false, error: `${res.error} A DTMS document was already created (tracking no. ${dtms.tracknumber}).` };
    }
    return {
      success: true,
      record: res.record,
      tracknumber: dtms.tracknumber,
      message: `${res.message} DTMS tracking no. ${dtms.tracknumber}`
    };
  } finally {
    submitsInFlight.delete(recordId);
  }
}

export async function testSendToDtms(kind, record, session) {
  let title;
  let filename;
  let message;
  let pdf;
  let signatories;

  if (kind === 'PPMP') {
    pdf = await buildPPMP_PDF_Blob(record);
    title = `PPMP No. ${record.ppmp_no} — ${record.end_user}`;
    filename = `TEST_PPMP_${record.ppmp_no}.pdf`;
    message = `Test copy only. PPMP No. ${record.ppmp_no} (FY ${record.fiscal_year}) of ${record.end_user}.`;
    signatories = buildSignatories(record, { skipHead: session?.stage === 'HEAD' });
  } else if (kind === 'APP') {
    const preview = await previewAPP_PDF(record.fiscal_year, record);
    if (!preview?.blob) throw new Error(`Could not generate the APP PDF for FY ${record.fiscal_year}.`);
    pdf = preview.blob;
    title = `APP FY ${record.fiscal_year}`;
    filename = `TEST_${preview.fileName}`;
    message = `Test copy only. Annual Procurement Plan for FY ${record.fiscal_year}.`;
    signatories = buildAppSignatories();
  } else {
    throw new Error(`Unsupported DTMS test document type: ${kind}.`);
  }

  const form = new FormData();
  form.append('title', `[TEST] ${title}`.slice(0, 100));
  form.append('requestor', (session?.roleName || 'PPMP System').slice(0, 100));
  form.append('position', (session?.role || 'Unit').slice(0, 100));
  form.append('message', `${message} This was sent from the project's DTMS test button.`);
  form.append('signatories', JSON.stringify(signatories));
  form.append('files', pdf, filename);
  const out = await asJson(await fetch(`${PROXY}/submit`, { method: 'POST', body: form }));
  return { tracknumber: out.tracknumber };
}

export const fetchDtmsStatus = async (track) => asJson(await fetch(`${PROXY}/status/${encodeURIComponent(track)}`));

// Copy DTMS state into the local record. Returns true if the record changed.
export function applyDtmsStatus(record, dtms) {
  if (!record.dtms_track || getPpmpStatus(record) !== 'For Approval') return false;
  const before = JSON.stringify([record.status, record.currentApproverRole, record.dtms_last]);
  record.dtms_last = `${dtms.status}|${dtms.progress?.signed}`;
  record.dtms_waiting_on = dtms.waiting_on || [];

  if (dtms.status === 'completed') {
    record.status = 'Completed';
    record.currentApproverRole = 'None';
    record.is_indicative = 'Final';
    record.approved_at = Date.now();
    record.approved_by = { name: 'DTMS', role: 'DTMS', email: '' };
    recordApprovedPpmpNumber(record); // keep the per-office/year PPMP number counter in step
    if (dtms.assigned_number) record.dtms_reference = dtms.assigned_number;
  } else if (dtms.status === 'rejected') {
    const who = (dtms.signatories || []).find(s => s.status === 'rejected');
    record.status = 'Draft';
    record.currentApproverRole = null;
    record.returned_for_revision = true;
    record.rejected_at = Date.now();
    record.rejected_by = { name: who?.name || 'DTMS', role: 'DTMS', email: who?.email || '', stage: '' };
    (record.remarksHistory ||= []).push({ stage: '', role: 'DTMS', name: who?.name || 'DTMS', action: 'rejected',
      remarks: who?.reason || 'Rejected in DTMS.', round: Number(record.submission_round) || 1,
      date: new Date().toLocaleDateString(), at: Date.now() });
    record.dtms_track = null; // next submission creates a new DTMS document
  } else {
    // for_signing: show the step currently waiting (by how many steps are done)
    const chain = getEffectiveApprovalChain(record);
    const done = Math.min(dtms.progress?.signed ?? 0, chain.length - 1);
    record.currentApproverRole = chain[done].role;
  }
  return before !== JSON.stringify([record.status, record.currentApproverRole, record.dtms_last]);
}

// Poll every record that is waiting in DTMS. Call on app start and every 30-60 s.
export async function syncAllWithDtms() {
  const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
  let changed = false;
  for (const r of all) {
    if (!r.dtms_track || getPpmpStatus(r) !== 'For Approval') continue;
    try { changed = applyDtmsStatus(r, await fetchDtmsStatus(r.dtms_track)) || changed; }
    catch (e) { console.warn('DTMS sync failed for', r.ppmp_no, e.message); }
  }
  if (changed) localStorage.setItem('procurement_records', JSON.stringify(all));
  return changed;
}