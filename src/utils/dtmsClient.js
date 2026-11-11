// DTMS integration for the PPMP app. Talks to server/dtms-proxy.js, never to DTMS directly.
import { APPROVAL_CHAIN, getPpmpStatus, recordApprovedPpmpNumber, getPpmpSubmitError, submitPpmpForApproval, getAllAppRecords, saveAppRecord } from './procurementRules.js';
import { buildPPMP_PDF_Blob, previewAPP_PDF } from './pdfGenerator.js';
import FileStore from './fileStore.js';

const PROXY = import.meta.env?.VITE_DTMS_PROXY || 'http://localhost:3001/api/dtms';

// ---------------------------------------------------------------------------
// DTMS signatories are configured separately so PPMP and APP routes stay independent.
// Emails must be ACTIVE DTMS users.
// ---------------------------------------------------------------------------

// DTMS signer steps apply digital signatures to the submitted PDF.
export const DTMS_ROLE = {
  PPMP: 'signer',
  APP: 'signer'
};

// PPMP chain. HEAD depends on the office (record.end_user); the rest are fixed.
// The Department Head, TOD, and Budget Officer sign in DTMS. RD approves locally afterward.
export const PPMP_SIGNERS = {
  HEAD: {
    'ICT Literacy Competency and Development bureau': '20140004282@my.xu.edu.ph',
    DEFAULT: '20140004282@my.xu.edu.ph'
  }, // office -> email
  TOD: '20140004282@my.xu.edu.ph',
  BO: '20140004282@my.xu.edu.ph'
};

const PPMP_DTMS_STAGES = APPROVAL_CHAIN.filter((step) => step.role !== 'RD');

// APP chain, in signing order. Edit this list freely without touching PPMP.
export const APP_SIGNERS = [
  { key: 'SUP', email: '20140004282@my.xu.edu.ph' },
  { key: 'ARD', email: '20140004282@my.xu.edu.ph' },
  { key: 'RD', email: '20140004282@my.xu.edu.ph' }
];

const normalizeOffice = (office) => String(office || '').trim().replace(/\s+/g, ' ').toLowerCase();

function getPpmpSignerEmail(record, stage) {
  const office = normalizeOffice(record.end_user);
  if (stage === 'HEAD') {
    return Object.entries(PPMP_SIGNERS.HEAD)
      .find(([name]) => normalizeOffice(name) === office)?.[1] || PPMP_SIGNERS.HEAD.DEFAULT;
  }
  return PPMP_SIGNERS[stage];
}

export function buildSignatories(record, stage = 'HEAD') {
  if (!PPMP_DTMS_STAGES.some((step) => step.role === stage)) {
    throw new Error(`PPMP stage "${stage}" does not sign in DTMS.`);
  }
  const email = getPpmpSignerEmail(record, stage);
  if (!email) throw new Error(`No DTMS email configured for PPMP step "${stage}".`);
  return [{ email, role: DTMS_ROLE.PPMP, order: 0 }];
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

export async function submitPpmpToDtms(record, session, stage = 'HEAD') {
  const pdf = stage === 'HEAD'
    ? await buildPPMP_PDF_Blob(record)
    : await FileStore.get(record.dtms_signed_file_id);
  if (!pdf) throw new Error('The previous DTMS-signed PDF is not available in this browser.');
  const form = new FormData();
  form.append('title', `PPMP No. ${record.ppmp_no} — ${record.end_user} — ${stage} signature`.slice(0, 100));
  form.append('requestor', (session?.roleName || record.submitted_by?.name || 'PPMP System').slice(0, 100));
  form.append('position', (session?.role || 'Unit').slice(0, 100));
  form.append('message', `PPMP No. ${record.ppmp_no} (FY ${record.fiscal_year}) of ${record.end_user}. Signature stage: ${stage}.`);
  form.append('signatories', JSON.stringify(buildSignatories(record, stage)));
  form.append('files', pdf, record.dtms_signed_file_name || `PPMP_${record.ppmp_no}.pdf`);
  const out = await asJson(await fetch(`${PROXY}/submit`, { method: 'POST', body: form }));
  return { tracknumber: out.tracknumber, submitted_at: Date.now() };
}

// The requester submits the initial PPMP copy for the Department Head's signature.
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
      dtms = await submitPpmpToDtms(record, session, 'HEAD');
    } catch (e) {
      return { success: false, error: e.message }; // nothing changed locally
    }

    const res = submitPpmpForApproval(recordId, session, {
      dtms_track: dtms.tracknumber,
      dtms_stage_roles: ['HEAD'],
      dtms_signing_stage: 'HEAD',
      currentApproverRole: 'HEAD',
      dtms_signing_complete: false,
      dtms_signed_file_id: null,
      dtms_signed_file_name: null,
      dtms_signed_file_track: null,
      dtms_signed_at: null,
      dtms_submissions: [...(record.dtms_submissions || []), {
        stage: 'HEAD',
        tracknumber: dtms.tracknumber,
        status: 'for_signing',
        submitted_at: dtms.submitted_at
      }]
    });
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

const stageSubmitsInFlight = new Set();
export async function submitPpmpStageToDtms(recordId, session, remarks = '') {
  if (!session?.canApprove || !['TOD', 'BO'].includes(session.stage)) {
    return { success: false, error: 'Only the current TOD or Budget Officer can send this PPMP for a DTMS signature.' };
  }
  if (stageSubmitsInFlight.has(recordId)) return { success: false, error: 'This PPMP is already being sent to DTMS.' };
  stageSubmitsInFlight.add(recordId);
  try {
    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const record = records.find((item) => item.id === recordId);
    if (!record) return { success: false, error: 'Record not found.' };
    if (getPpmpStatus(record) !== 'For Approval' ||
      record.currentApproverRole !== session.stage ||
      !record.dtms_signing_complete ||
      record.dtms_signed_file_track !== record.dtms_track) {
      return { success: false, error: 'This PPMP is not ready for your DTMS signature step.' };
    }

    let dtms;
    try {
      dtms = await submitPpmpToDtms(record, session, session.stage);
    } catch (error) {
      return { success: false, error: error.message };
    }

    record.dtms_track = dtms.tracknumber;
    record.dtms_stage_roles = [session.stage];
    record.dtms_signing_stage = session.stage;
    record.dtms_signing_complete = false;
    record.dtms_waiting_on = [];
    record.dtms_last = null;
    if (remarks.trim()) record.dtms_review_remarks = remarks.trim();
    (record.dtms_submissions ||= []).push({
      stage: session.stage,
      tracknumber: dtms.tracknumber,
      status: 'for_signing',
      submitted_at: dtms.submitted_at
    });

    try {
      localStorage.setItem('procurement_records', JSON.stringify(records));
    } catch {
      return {
        success: false,
        error: `DTMS created tracking no. ${dtms.tracknumber}, but the local record could not be updated. Do not resubmit until you reconcile this tracking number.`
      };
    }
    return {
      success: true,
      record,
      tracknumber: dtms.tracknumber,
      message: `PPMP sent to DTMS for the ${session.stage} signature. Tracking no. ${dtms.tracknumber}`
    };
  } finally {
    stageSubmitsInFlight.delete(recordId);
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
    signatories = buildSignatories(record, 'HEAD');
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

export async function fetchDtmsFile(track, fileId) {
  const response = await fetch(`${PROXY}/files/${encodeURIComponent(track)}/${encodeURIComponent(fileId)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`DTMS ${response.status}: ${body.detail || response.statusText}`);
  }
  return response.blob();
}

function getDtmsFileId(file) {
  const id = file?.id ?? file?.file_id;
  if (id !== undefined && id !== null && String(id).trim()) return String(id).trim();
  if (!file?.url) return null;
  try {
    const url = new URL(file.url, PROXY);
    const match = url.pathname.match(/\/files\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function saveSignedFile(record, dtms) {
  if (record.dtms_signed_file_track === record.dtms_track || dtms.status !== 'completed') return false;
  const files = Array.isArray(dtms.file_list)
    ? dtms.file_list
    : Array.isArray(dtms.files) ? dtms.files : [];
  const originals = files.filter((entry) => String(entry.type || '').trim().toLowerCase() === 'original');
  const eligible = files.filter((entry) => String(entry.type || '').trim().toLowerCase() !== 'supporting');
  const file = originals[0] || (eligible.length === 1 ? eligible[0] : null);
  const dtmsFileId = getDtmsFileId(file);
  if (!file || !dtmsFileId) {
    const types = files.map((entry) => String(entry.type || 'unspecified')).join(', ') || 'none';
    throw new Error(`DTMS marked ${record.dtms_track} completed but did not provide an identifiable original PDF (file types: ${types}).`);
  }
  const blob = await fetchDtmsFile(record.dtms_track, dtmsFileId);
  if (!blob.size) throw new Error(`DTMS returned an empty PDF for tracking no. ${record.dtms_track}.`);
  const fileId = FileStore.newId();
  await FileStore.put(fileId, blob);
  record.dtms_signed_file_id = fileId;
  record.dtms_signed_file_name = file.name || `DTMS_${record.dtms_track}.pdf`;
  record.dtms_signed_file_track = record.dtms_track;
  record.dtms_signed_at = Date.now();
  const submission = record.dtms_submissions?.find((item) => item.tracknumber === record.dtms_track);
  if (submission) {
    submission.signed_file_id = fileId;
    submission.signed_file_name = record.dtms_signed_file_name;
  }
  return true;
}

export async function downloadSignedDtmsFile(record) {
  if (!record?.dtms_signed_file_id) throw new Error('No signed DTMS PDF is available yet.');
  const blob = await FileStore.get(record.dtms_signed_file_id);
  if (!blob) throw new Error('The signed PDF is missing from this browser’s file storage.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = record.dtms_signed_file_name || `DTMS_${record.dtms_track || 'signed'}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Copy DTMS state into the local record. Returns true if the record changed.
export function applyDtmsStatus(record, dtms) {
  if (!record.dtms_track || !['For Approval', 'Draft'].includes(getPpmpStatus(record))) return false;
  if (dtms.status === 'completed' && record.dtms_signing_complete && record.dtms_last?.startsWith('completed|')) {
    return false;
  }
  const before = JSON.stringify([record.status, record.currentApproverRole, record.dtms_last]);
  record.dtms_last = `${dtms.status}|${dtms.progress?.signed}`;
  record.dtms_waiting_on = dtms.waiting_on || [];

  if (dtms.status === 'for_signing') {
    const stages = record.dtms_stage_roles || APPROVAL_CHAIN.map((step) => step.role);
    const done = Math.min(dtms.progress?.signed ?? 0, stages.length - 1);
    record.status = 'For Approval';
    record.currentApproverRole = stages[done];
  } else if (dtms.status === 'completed') {
    const stages = record.dtms_stage_roles || APPROVAL_CHAIN.map((step) => step.role);
    const completedStage = record.dtms_signing_stage || stages[stages.length - 1];
    const completedIdx = PPMP_DTMS_STAGES.findIndex((step) => step.role === completedStage);
    const legacyFullChain = !record.dtms_signing_stage && stages.includes('RD');
    const nextStage = legacyFullChain ? null : PPMP_DTMS_STAGES[completedIdx + 1]?.role || 'RD';
    const signer = (dtms.signatories || []).find((item) => item.order === 0);
    const submission = record.dtms_submissions?.find((item) => item.tracknumber === record.dtms_track);
    if (submission) {
      submission.status = 'completed';
      submission.completed_at = Date.now();
    }
    record.dtms_signing_complete = true;
    record.dtms_waiting_on = [];
    if (!Array.isArray(record.remarksHistory)) record.remarksHistory = [];
    record.remarksHistory.push({
      stage: completedStage,
      role: 'DTMS',
      name: signer?.name || 'DTMS signer',
      action: 'approved',
      remarks: record.dtms_review_remarks || 'Digitally signed in DTMS.',
      round: Number(record.submission_round) || 1,
      date: signer?.signed_at ? new Date(signer.signed_at).toLocaleDateString() : new Date().toLocaleDateString(),
      at: signer?.signed_at ? Date.parse(signer.signed_at) || Date.now() : Date.now()
    });
    record.dtms_review_remarks = '';
    if (legacyFullChain) {
      record.status = 'Completed';
      record.currentApproverRole = 'None';
      record.is_indicative = 'Final';
      record.approved_at = Date.now();
      record.approved_by = { name: signer?.name || 'DTMS', role: 'DTMS', email: signer?.email || '' };
      recordApprovedPpmpNumber(record);
    } else {
      record.status = 'For Approval';
      record.currentApproverRole = nextStage;
    }
    if (dtms.assigned_number) record.dtms_reference = dtms.assigned_number;
  } else if (dtms.status === 'rejected') {
    const who = (dtms.signatories || []).find(s => s.status === 'rejected');
    const stage = record.dtms_signing_stage || record.dtms_stage_roles?.[who?.order] || '';
    const submission = record.dtms_submissions?.find((item) => item.tracknumber === record.dtms_track);
    if (submission) {
      submission.status = 'rejected';
      submission.completed_at = Date.now();
      submission.reason = who?.reason || '';
    }
    record.status = 'Draft';
    record.currentApproverRole = null;
    record.returned_for_revision = true;
    record.rejected_at = Date.now();
    record.rejected_by = { name: who?.name || 'DTMS', role: 'DTMS', email: who?.email || '', stage };
    (record.remarksHistory ||= []).push({ stage, role: 'DTMS', name: who?.name || 'DTMS', action: 'rejected',
      remarks: who?.reason || 'Rejected in DTMS.', round: Number(record.submission_round) || 1,
      date: new Date().toLocaleDateString(), at: Date.now() });
    record.dtms_rejected_track = record.dtms_track;
    record.dtms_track = null;
    record.dtms_signing_complete = false;
    record.dtms_review_remarks = '';
  }
  return before !== JSON.stringify([record.status, record.currentApproverRole, record.dtms_last]);
}

function applyAppDtmsStatus(record, dtms) {
  if (!record.dtms_track || !['For Approval', 'Draft'].includes(record.status)) return false;
  const before = JSON.stringify([record.status, record.currentApproverRole, record.dtms_last]);
  record.dtms_last = `${dtms.status}|${dtms.progress?.signed}`;
  record.dtms_waiting_on = dtms.waiting_on || [];
  const stages = record.dtms_stage_roles || APP_SIGNERS.map((signer) => signer.key);

  if (dtms.status === 'for_signing') {
    const done = Math.min(dtms.progress?.signed ?? 0, stages.length - 1);
    record.status = 'For Approval';
    record.currentApproverRole = stages[done];
  } else if (dtms.status === 'completed') {
    record.status = 'Completed';
    record.currentApproverRole = 'None';
    record.returned_for_revision = false;
    const rd = (dtms.signatories || []).find((signer) => signer.order === stages.indexOf('RD'));
    record.approved_by = { name: rd?.name || 'DTMS', role: 'RD', email: rd?.email || '' };
    record.approved_at = rd?.signed_at ? Date.parse(rd.signed_at) || Date.now() : Date.now();
    if (dtms.assigned_number) record.dtms_reference = dtms.assigned_number;
  } else if (dtms.status === 'rejected') {
    const who = (dtms.signatories || []).find((signer) => signer.status === 'rejected');
    const stage = stages[who?.order] || '';
    record.status = 'Draft';
    record.currentApproverRole = null;
    record.returned_for_revision = true;
    record.rejected_at = Date.now();
    record.rejected_by = { name: who?.name || 'DTMS', role: 'DTMS', email: who?.email || '', stage };
    (record.remarksHistory ||= []).push({
      stage, role: 'DTMS', name: who?.name || 'DTMS', action: 'rejected',
      remarks: who?.reason || 'Rejected in DTMS.', date: new Date().toLocaleDateString(), at: Date.now()
    });
  }
  return before !== JSON.stringify([record.status, record.currentApproverRole, record.dtms_last]);
}

const appSubmitsInFlight = new Set();
export async function submitAppViaDtms(fiscalYear, session) {
  const year = String(fiscalYear);
  if (!session || session.role !== 'SUP') return { success: false, error: 'Only Supply can submit an APP.' };
  if (appSubmitsInFlight.has(year)) return { success: false, error: 'This APP is already being submitted.' };
  appSubmitsInFlight.add(year);
  try {
    const all = getAllAppRecords();
    const record = all.find((app) => String(app.fiscal_year) === year) || {
      id: `app_${year}`, fiscal_year: year, status: 'Draft', remarksHistory: []
    };
    if (record.status !== 'Draft') return { success: false, error: 'Only a Draft APP can be submitted.' };

    const preview = await previewAPP_PDF(year, record);
    if (!preview?.blob) throw new Error(`Could not generate the APP PDF for FY ${year}.`);
    const signatories = buildAppSignatories();
    const form = new FormData();
    form.append('title', `APP FY ${year}`);
    form.append('requestor', (session.roleName || 'Supply').slice(0, 100));
    form.append('position', (session.role || 'SUP').slice(0, 100));
    form.append('message', `Annual Procurement Plan for FY ${year} for approval.`);
    form.append('signatories', JSON.stringify(signatories));
    form.append('files', preview.blob, preview.fileName || `APP_${year}.pdf`);
    const out = await asJson(await fetch(`${PROXY}/submit`, { method: 'POST', body: form }));

    const updated = {
      ...record,
      status: 'For Approval',
      currentApproverRole: 'SUP',
      dtms_track: out.tracknumber,
      dtms_stage_roles: APP_SIGNERS.map((signer) => signer.key),
      returned_for_revision: false,
      submitted_by: { name: session.roleName || 'Supply', role: session.role },
      submitted_at: Date.now()
    };
    saveAppRecord(updated);
    return { success: true, record: updated, tracknumber: out.tracknumber };
  } finally {
    appSubmitsInFlight.delete(year);
  }
}

// Poll every record that is waiting in DTMS. Call on app start and every 30-60 s.
let syncInFlight = null;
async function performSyncAllWithDtms() {
  const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
  let changed = false;
  const errors = [];
  for (const r of all) {
    const status = getPpmpStatus(r);
    if (!r.dtms_track || (r.dtms_signing_complete && r.dtms_signed_file_track === r.dtms_track) ||
      (!['For Approval', 'Draft'].includes(status) && !(status === 'Completed' && !r.dtms_signed_file_id))) continue;
    try {
      const dtms = await fetchDtmsStatus(r.dtms_track);
      changed = applyDtmsStatus(r, dtms) || changed;
      changed = await saveSignedFile(r, dtms) || changed;
    }
    catch (e) {
      const message = `PPMP ${r.ppmp_no}: ${e.message}`;
      console.warn('DTMS sync failed:', message);
      errors.push(message);
    }
  }
  if (changed) localStorage.setItem('procurement_records', JSON.stringify(all));

  for (const app of getAllAppRecords()) {
    if (!app.dtms_track || (!['For Approval', 'Draft'].includes(app.status) && !(app.status === 'Completed' && !app.dtms_signed_file_id))) continue;
    try {
      const dtms = await fetchDtmsStatus(app.dtms_track);
      if (applyAppDtmsStatus(app, dtms)) {
        saveAppRecord(app);
        changed = true;
      }
      const fileChanged = await saveSignedFile(app, dtms);
      if (fileChanged) {
        saveAppRecord(app);
        changed = true;
      }
    } catch (e) {
      const message = `APP FY ${app.fiscal_year}: ${e.message}`;
      console.warn('DTMS sync failed:', message);
      errors.push(message);
    }
  }
  if (errors.length) {
    throw new Error(errors.slice(0, 3).join(' | '));
  }
  return changed;
}

export function syncAllWithDtms() {
  if (!syncInFlight) {
    syncInFlight = performSyncAllWithDtms().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}