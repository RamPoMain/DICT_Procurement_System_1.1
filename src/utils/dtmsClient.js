// DTMS integration for the PPMP app. Talks to server/dtms-proxy.js, never to DTMS directly.
import { APPROVAL_CHAIN, getPpmpStatus, recordApprovedPpmpNumber, getPpmpSubmitError, submitPpmpForApproval, getAllAppRecords, getAppRecord, saveAppRecord } from './procurementRules.js';
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
    'ICT Literacy Competency and Development bureau': '20210022244@my.xu.edu.ph',
    'Free Public Wi-Fi and Broadband Infrastructure bureau': '20210022244@my.xu.edu.ph',
    DEFAULT: '20210022244@my.xu.edu.ph'
  }, // office -> email
  TOD: '20210022244@my.xu.edu.ph',
  BO: '20210022244@my.xu.edu.ph'
};

const PPMP_DTMS_STAGES = APPROVAL_CHAIN.filter((step) => step.role !== 'RD');

// APP chain. Same one-stage-at-a-time handoff as PPMP, with every stage signing in DTMS:
//   Supply submits -> DTMS signature (SUP) -> signed PDF returns -> ARD reviews in the system
//   -> DTMS signature (ARD) -> signed PDF returns -> RD reviews in the system
//   -> DTMS signature (RD) -> the RD-signed PDF returns and the APP becomes Final.
export const APP_CHAIN = [
  { role: 'SUP', label: 'Supply' },
  { role: 'ARD', label: 'Assistant Regional Director' },
  { role: 'RD', label: 'Regional Director' }
];
const APP_DTMS_STAGES = APP_CHAIN;

// DTMS signers for the APP, one per stage. Emails must be ACTIVE DTMS users.
export const APP_SIGNERS = [
  { key: 'SUP', email: '20210022244@my.xu.edu.ph' },
  { key: 'ARD', email: '20210022244@my.xu.edu.ph' },
  { key: 'RD', email: '20210022244@my.xu.edu.ph' }
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

export function buildAppSignatories(stage = 'SUP') {
  if (!APP_DTMS_STAGES.some((step) => step.role === stage)) {
    throw new Error(`APP stage "${stage}" does not sign in DTMS.`);
  }
  const email = APP_SIGNERS.find((s) => s.key === stage)?.email;
  if (!email) throw new Error(`No DTMS email configured for APP step "${stage}".`);
  return [{ email, role: DTMS_ROLE.APP, order: 0 }];
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
    signatories = buildAppSignatories('SUP');
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

// Copy DTMS state into the local APP record. Mirrors applyDtmsStatus for PPMPs: each DTMS document
// carries ONE signature, then the APP waits in the system for the next reviewer.
function applyAppDtmsStatus(record, dtms) {
  if (!record.dtms_track || !['For Approval', 'Draft'].includes(record.status)) return false;
  if (dtms.status === 'completed' && record.dtms_signing_complete && record.dtms_last?.startsWith('completed|')) {
    return false;
  }
  const before = JSON.stringify([record.status, record.currentApproverRole, record.dtms_last]);
  record.dtms_last = `${dtms.status}|${dtms.progress?.signed}`;
  record.dtms_waiting_on = dtms.waiting_on || [];
  const stages = record.dtms_stage_roles || APP_CHAIN.map((step) => step.role);

  if (dtms.status === 'for_signing') {
    const done = Math.min(dtms.progress?.signed ?? 0, stages.length - 1);
    record.status = 'For Approval';
    record.currentApproverRole = stages[done];
  } else if (dtms.status === 'completed') {
    const completedStage = record.dtms_signing_stage || stages[stages.length - 1];
    const completedIdx = APP_DTMS_STAGES.findIndex((step) => step.role === completedStage);
    // APPs submitted before this change had all three signers in one DTMS document.
    const legacyFullChain = !record.dtms_signing_stage && stages.includes('RD');
    const isFinalStage = legacyFullChain || completedIdx === APP_DTMS_STAGES.length - 1; // RD's signature finishes the APP
    const nextStage = isFinalStage ? null : APP_DTMS_STAGES[completedIdx + 1].role;
    const signer = (dtms.signatories || []).find((item) => item.order === (legacyFullChain ? stages.indexOf('RD') : 0));
    const signedAt = signer?.signed_at ? Date.parse(signer.signed_at) || Date.now() : Date.now();
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
      date: new Date(signedAt).toLocaleDateString(),
      at: signedAt
    });
    record.dtms_review_remarks = '';
    // Per-stage signature, shown in the APP's signature block.
    record.signatures = {
      ...(record.signatures || {}),
      [completedStage]: { name: signer?.name || 'DTMS signer', email: signer?.email || '', signed_at: signedAt }
    };
    if (completedStage === 'ARD') {
      record.ard_approved_by = { name: signer?.name || 'DTMS signer', role: 'ARD', email: signer?.email || '' };
      record.ard_approved_at = signedAt;
    }
    if (isFinalStage) {
      record.status = 'Completed';
      record.currentApproverRole = 'None';
      record.returned_for_revision = false;
      record.approved_by = { name: signer?.name || 'DTMS', role: 'RD', email: signer?.email || '' };
      record.approved_at = signedAt;
    } else {
      record.status = 'For Approval';
      record.currentApproverRole = nextStage; // reviews in the system once the signed PDF is saved
    }
    if (dtms.assigned_number) record.dtms_reference = dtms.assigned_number;
  } else if (dtms.status === 'rejected') {
    const who = (dtms.signatories || []).find((signer) => signer.status === 'rejected');
    const stage = record.dtms_signing_stage || stages[who?.order] || '';
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
    (record.remarksHistory ||= []).push({
      stage, role: 'DTMS', name: who?.name || 'DTMS', action: 'rejected',
      remarks: who?.reason || 'Rejected in DTMS.', round: Number(record.submission_round) || 1,
      date: new Date().toLocaleDateString(), at: Date.now()
    });
    record.dtms_rejected_track = record.dtms_track;
    record.dtms_track = null;
    record.dtms_signing_complete = false;
    record.dtms_review_remarks = '';
  }
  return before !== JSON.stringify([record.status, record.currentApproverRole, record.dtms_last]);
}

// Sends the APP PDF to DTMS for ONE stage's signature. SUP signs the freshly generated APP;
// later stages sign the PDF that came back from the previous DTMS signature.
async function submitAppToDtms(record, session, stage) {
  const year = record.fiscal_year;
  let pdf;
  let fileName;
  if (stage === APP_DTMS_STAGES[0].role) {
    const preview = await previewAPP_PDF(year, record);
    if (!preview?.blob) throw new Error(`Could not generate the APP PDF for FY ${year}.`);
    pdf = preview.blob;
    fileName = preview.fileName || `APP_${year}.pdf`;
  } else {
    pdf = await FileStore.get(record.dtms_signed_file_id);
    if (!pdf) throw new Error('The previous DTMS-signed APP PDF is not available in this browser.');
    fileName = record.dtms_signed_file_name || `APP_${year}.pdf`;
  }
  const form = new FormData();
  form.append('title', `APP FY ${year} — ${stage} signature`.slice(0, 100));
  form.append('requestor', (session?.roleName || 'Procurement System').slice(0, 100));
  form.append('position', (session?.role || stage).slice(0, 100));
  form.append('message', `Annual Procurement Plan for FY ${year}. Signature stage: ${stage}.`);
  form.append('signatories', JSON.stringify(buildAppSignatories(stage)));
  form.append('files', pdf, fileName);
  const out = await asJson(await fetch(`${PROXY}/submit`, { method: 'POST', body: form }));
  return { tracknumber: out.tracknumber, submitted_at: Date.now() };
}

// Supply submits the APP to DTMS for Supply's signature. After signing, it returns for ARD review.
const appSubmitsInFlight = new Set();
export async function submitAppViaDtms(fiscalYear, session) {
  const year = String(fiscalYear);
  if (!session || session.role !== 'SUP') return { success: false, error: 'Only Supply can submit an APP.' };
  if (appSubmitsInFlight.has(year)) return { success: false, error: 'This APP is already being submitted.' };
  appSubmitsInFlight.add(year);
  try {
    const record = getAppRecord(year);
    if (record.status !== 'Draft') return { success: false, error: 'Only a Draft APP can be submitted.' };

    let dtms;
    try {
      dtms = await submitAppToDtms(record, session, 'SUP');
    } catch (e) {
      return { success: false, error: e.message }; // nothing changed locally
    }

    const updated = {
      ...record,
      status: 'For Approval',
      currentApproverRole: 'SUP',
      dtms_track: dtms.tracknumber,
      dtms_stage_roles: ['SUP'],
      dtms_signing_stage: 'SUP',
      dtms_signing_complete: false,
      dtms_waiting_on: [],
      dtms_last: null,
      dtms_review_remarks: '',
      dtms_signed_file_id: null,
      dtms_signed_file_name: null,
      dtms_signed_file_track: null,
      dtms_signed_at: null,
      signatures: {},
      ard_approved_by: null,
      ard_approved_at: null,
      dtms_submissions: [...(record.dtms_submissions || []), {
        stage: 'SUP',
        tracknumber: dtms.tracknumber,
        status: 'for_signing',
        submitted_at: dtms.submitted_at
      }],
      returned_for_revision: false,
      submission_round: (Number(record.submission_round) || 1) + (record.rejected_at ? 1 : 0),
      submitted_by: { name: session.roleName || 'Supply', role: session.role, email: session.email },
      submitted_at: Date.now()
    };
    try {
      saveAppRecord(updated);
    } catch {
      return {
        success: false,
        error: `DTMS created tracking no. ${dtms.tracknumber}, but the local record could not be updated. Do not resubmit until you reconcile this tracking number.`
      };
    }
    return {
      success: true,
      record: updated,
      tracknumber: dtms.tracknumber,
      message: `APP sent to DTMS for Supply's signature. Tracking no. ${dtms.tracknumber}`
    };
  } finally {
    appSubmitsInFlight.delete(year);
  }
}

// A reviewer (ARD) approves in the system, which sends the signed PDF on to DTMS for their signature.
const appStageSubmitsInFlight = new Set();
export async function submitAppStageToDtms(fiscalYear, session, remarks = '') {
  const year = String(fiscalYear);
  const signingRoles = APP_DTMS_STAGES.slice(1).map((step) => step.role); // review first, then sign
  if (!session?.canApprove || !signingRoles.includes(session.role)) {
    return { success: false, error: 'Only the current ARD or RD can send this APP to DTMS for a signature.' };
  }
  if (appStageSubmitsInFlight.has(year)) return { success: false, error: 'This APP is already being sent to DTMS.' };
  appStageSubmitsInFlight.add(year);
  try {
    const record = getAppRecord(year);
    if (record.status !== 'For Approval' ||
      record.currentApproverRole !== session.role ||
      !record.dtms_signing_complete ||
      record.dtms_signed_file_track !== record.dtms_track) {
      return { success: false, error: 'This APP is not ready for your DTMS signature step.' };
    }

    let dtms;
    try {
      dtms = await submitAppToDtms(record, session, session.role);
    } catch (error) {
      return { success: false, error: error.message };
    }

    record.dtms_track = dtms.tracknumber;
    record.dtms_stage_roles = [session.role];
    record.dtms_signing_stage = session.role;
    record.dtms_signing_complete = false;
    record.dtms_waiting_on = [];
    record.dtms_last = null;
    if (remarks.trim()) record.dtms_review_remarks = remarks.trim();
    (record.dtms_submissions ||= []).push({
      stage: session.role,
      tracknumber: dtms.tracknumber,
      status: 'for_signing',
      submitted_at: dtms.submitted_at
    });

    try {
      saveAppRecord(record);
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
      message: `APP sent to DTMS for the ${session.role} signature. Tracking no. ${dtms.tracknumber}`
    };
  } finally {
    appStageSubmitsInFlight.delete(year);
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
    if (!app.dtms_track || (app.dtms_signing_complete && app.dtms_signed_file_track === app.dtms_track) ||
      (!['For Approval', 'Draft'].includes(app.status) && !(app.status === 'Completed' && app.dtms_signed_file_track !== app.dtms_track))) continue;
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