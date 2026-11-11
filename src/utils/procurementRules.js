// ============================================================
// PROCUREMENT RULES & CALCULATION ENGINE
// ============================================================

export const APPROVAL_CHAIN = [
  { role: 'HEAD', label: 'Unit Head' },
  { role: 'TOD',  label: 'Technical Operations Division' },
  { role: 'BO',   label: 'Budget Officer' },
  { role: 'RD',   label: 'Regional Director' }
];

// A Unit Head who submits for their own unit auto-endorses, so HEAD never reviews that round
// (see submitPpmpForApproval). Detected from the 'submitted' remark logged for the current round.
export function isHeadStepSkipped(record) {
  if (!record || !Array.isArray(record.remarksHistory)) return false;
  const round = Number(record.submission_round) || 1;
  return record.remarksHistory.some(h => h && h.action === 'submitted' && h.stage === 'HEAD' && Number(h.round) === round);
}

// The approval steps that actually apply to this record (HEAD removed when the Unit Head submitted).
export function getEffectiveApprovalChain(record) {
  return isHeadStepSkipped(record) ? APPROVAL_CHAIN.filter(step => step.role !== 'HEAD') : APPROVAL_CHAIN;
}

export function getApprovalStep(stage) {
  return APPROVAL_CHAIN.find(step => step.role === stage) || null;
}

export const PROJECT_TYPE_DOC_LABELS = {
  'Goods': 'Technical Specifications',
  'Consulting Services': 'Terms of Reference',
  'Infrastructure': 'Scope of Work'
};

export function getRequiredDocLabel(projectType) {
  return PROJECT_TYPE_DOC_LABELS[projectType] || 'supporting document';
}

export function itemHasSupportingDocument(item) {
  return !!item && Array.isArray(item.supporting_documents) && item.supporting_documents.length > 0;
}

export function getItemsMissingDocuments(record) {
  return getRecordItems(record)
    .map((item, index) => ({ number: index + 1, item }))
    .filter(entry => !itemHasSupportingDocument(entry.item));
}

export function getItemsBudgetModeMismatch(record) {
  return getRecordItems(record)
    .map((item, index) => ({ number: index + 1, item }))
    .filter(entry => {
      const n = parseBudgetNumber(entry.item.budget);
      return isBracketMismatch(String(entry.item.mode || '').trim(), n);
    });
}

export function buildBudgetMismatchMessage(list) {
  const shown = list.slice(0, 3).map(m => {
    const n = parseBudgetNumber(m.item.budget);
    return `Item ${m.number} (${formatPesoExact(n)} is not within ${m.item.mode})`;
  });
  const more = list.length - shown.length;
  return `Fix the Mode of Procurement or Estimated Budget before submitting: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}. Open the PPMP and press Edit on each item.`;
}

export function buildMissingDocsMessage(missing) {
  const shown = missing.slice(0, 3).map(m => `Item ${m.number} (${getRequiredDocLabel(m.item.project_type)})`);
  const more = missing.length - shown.length;
  return `Attach a supporting document before submitting: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}. Open the PPMP and press Edit on each item.`;
}

export const PROCUREMENT_MODE_RULES = {
  'Direct Acquisition': {
    mode: 'Direct Acquisition',
    minBudget: 0.01,
    maxBudget: 200000,
    allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
    legalBasis: 'RA 12009 Sec. 32',
    bracketLabel: '₱0 – ₱199,999'
  },
  'Small Value Procurement (SVP)': {
    mode: 'Small Value Procurement (SVP)',
    minBudget: 0.01,
    maxBudget: 2000000,
    allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
    legalBasis: 'RA 12009 Sec. 31',
    bracketLabel: '₱200,000 – ₱1,999,999'
  },
  'Shopping': {
    mode: 'Shopping',
    minBudget: 0.01,
    maxBudget: 2000000,
    allowedTypes: ['Goods'],
    legalBasis: 'RA 12009 Sec. 30',
    bracketLabel: '₱0 – ₱2,000,000 (Goods only)'
  },
  'Competitive Bidding': {
    mode: 'Competitive Bidding',
    minBudget: 0.01,
    maxBudget: Infinity,
    allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
    legalBasis: 'RA 12009 Sec. 15',
    bracketLabel: '₱2,000,000 and above'
  },
  'Repeat Order': {
    mode: 'Repeat Order',
    minBudget: 0.01,
    maxBudget: Infinity,
    allowedTypes: ['Goods'],
    legalBasis: 'RA 12009 Sec. 29'
  },
  'Direct Contracting': {
    mode: 'Direct Contracting',
    minBudget: 0.01,
    maxBudget: Infinity,
    allowedTypes: ['Goods', 'Consulting Services'],
    legalBasis: 'RA 12009 Sec. 28'
  },
  'Negotiated Procurement': {
    mode: 'Negotiated Procurement',
    minBudget: 0.01,
    maxBudget: Infinity,
    allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
    legalBasis: 'RA 12009 Sec. 33',
    bracketLabel: 'Negotiated Procurement'
  },
  'Negotiated Procurement – Two Failed Biddings': {
    mode: 'Negotiated Procurement – Two Failed Biddings',
    minBudget: 0.01,
    maxBudget: Infinity,
    allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
    legalBasis: 'RA 12009 Sec. 33',
    bracketLabel: 'Two failed biddings (Sec. 33)'
  },
  'Negotiated Procurement - Two Failed Biddings': {
    mode: 'Negotiated Procurement - Two Failed Biddings',
    minBudget: 0.01,
    maxBudget: Infinity,
    allowedTypes: ['Goods', 'Infrastructure', 'Consulting Services'],
    legalBasis: 'RA 12009 Sec. 33',
    bracketLabel: 'Two failed biddings (Sec. 33)'
  }
};

export const STANDARD_PROCUREMENT_MODES = [
  'Direct Acquisition',
  'Small Value Procurement (SVP)',
  'Shopping',
  'Competitive Bidding',
  'Repeat Order',
  'Direct Contracting',
  'Negotiated Procurement'
];

export const MODE_BUDGET_BRACKETS = [
  { below: 200000, mode: 'Direct Acquisition', label: '₱0 – ₱199,999' },
  { below: 2000000, mode: 'Small Value Procurement (SVP)', label: '₱200,000 – ₱1,999,999' },
  { below: Infinity, mode: 'Competitive Bidding', label: '₱2,000,000 and above' }
];

export function getRecommendedMode(budget) {
  return MODE_BUDGET_BRACKETS.find(t => budget < t.below) || MODE_BUDGET_BRACKETS[2];
}

export function isBracketMode(modeValue) {
  return MODE_BUDGET_BRACKETS.some(tier => tier.mode === modeValue);
}

export function isBracketMismatch(mode, budget) {
  if (!isBracketMode(mode) || !(budget > 0)) return false;
  return getRecommendedMode(budget).mode !== mode;
}

export function exceedsModeCeiling(modeValue, budgetNumber) {
  const rule = PROCUREMENT_MODE_RULES[modeValue];
  if (!rule) return false;
  if (modeValue === 'Direct Acquisition') return budgetNumber >= 200000;
  if (modeValue === 'Small Value Procurement (SVP)') return budgetNumber >= 2000000;
  return budgetNumber > rule.maxBudget;
}

export function formatPesoMessage(amount) {
  return '₱' + Number(amount || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function budgetBracketMessage(modeValue, budgetNumber) {
  const own = MODE_BUDGET_BRACKETS.find(tier => tier.mode === modeValue);
  const rec = getRecommendedMode(budgetNumber);
  const rule = PROCUREMENT_MODE_RULES[modeValue] || {};
  return `Estimated budget of ${formatPesoMessage(budgetNumber)} is outside the ${modeValue} bracket (${own ? own.label : 'n/a'}). It falls under ${rec.mode} (${rec.label})${rule.legalBasis ? ` - ${rule.legalBasis}.` : '.'}`;
}

export function parseBudgetNumber(val) {
  if (!val) return 0;
  const p = parseFloat(String(val).replace(/^\s*(?:PHP|P|₱)\s*/i, '').replace(/,/g, ''));
  return isNaN(p) ? 0 : p;
}

export function formatPeso(amount) {
  if (amount >= 1000000) return '₱' + (amount / 1000000).toFixed(amount % 1000000 === 0 ? 0 : 1) + 'M';
  if (amount >= 1000) return '₱' + (amount / 1000).toFixed(amount % 1000 === 0 ? 0 : 1) + 'K';
  return '₱' + Number(amount || 0).toLocaleString('en-PH');
}

export function formatPesoExact(amount) {
  return 'P ' + Number(amount || 0).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function getRecordItems(record) {
  if (!record) return [];
  if (Array.isArray(record.items) && record.items.length > 0) return record.items;
  return [record];
}

export function calculateDeduplicatedBudget(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const refBudgetMap = new Map();
  let noRefTotal = 0;

  items.forEach(item => {
    if (!item) return;
    const b = parseBudgetNumber(item.budget);
    const ref = item.reference_no ? String(item.reference_no).trim() : null;
    if (ref) {
      refBudgetMap.set(ref, b);
    } else {
      noRefTotal += b;
    }
  });

  let total = noRefTotal;
  refBudgetMap.forEach(b => { total += b; });
  return total;
}

export function getPpmpStatus(record) {
  if (!record) return 'Draft';
  if (record.status === 'Completed') return 'Completed';
  if (record.status === 'For Approval') return 'For Approval';
  return 'Draft';
}

export function isPpmpDraft(r) { return getPpmpStatus(r) === 'Draft'; }
export function isPpmpLocked(r) { return getPpmpStatus(r) !== 'Draft'; }
export function isPpmpReturned(r) { return !!r && isPpmpDraft(r) && !!r.returned_for_revision; }

// Reference number generator (GDS, INF, CSV, GEN)
const ENTRY_REF_CATEGORIES = {
  'Goods': 'GDS',
  'Infrastructure': 'INF',
  'Consulting Services': 'CSV'
};

export function claimEntryRef(records, projectType, fiscalYear) {
  const code = ENTRY_REF_CATEGORIES[String(projectType || '').trim()] || 'GEN';
  const year = String(fiscalYear || new Date().getFullYear()).trim();
  let highest = 0;

  (records || []).forEach(r => {
    getRecordItems(r).forEach(it => {
      const m = /^(\d{4})-([A-Z]{3})-(\d+)$/.exec(String(it.reference_no || ''));
      if (m && m[1] === year && m[2] === code) {
        const n = parseInt(m[3], 10);
        if (n > highest) highest = n;
      }
    });
  });

  const next = String(highest + 1).padStart(4, '0');
  return `${year}-${code}-${next}`;
}

// Two Failed Biddings Finder (RA 12009 Sec. 33)
export function normalizeDescription(description) {
  return String(description || '')
    .replace(/^\[(?:1st|2nd|3rd)\s+Failure\]\s*/i, '')
    .trim()
    .toLowerCase();
}

export function findExistingReferenceInfo(description, projectType, currentRecord, office) {
  const normDesc = normalizeDescription(description);
  const offNorm = String(office || '').trim().toLowerCase();
  if (!normDesc) return null;

  const allRecords = JSON.parse(localStorage.getItem('procurement_records')) || [];
  let matchedRefNo = null;
  let competitiveCount = 0;
  const matchingItems = [];
  const seenAttemptKeys = new Set();

  const checkItem = (it) => {
    if (!it) return;
    const itNormDesc = normalizeDescription(it.project_description);
    if (itNormDesc !== normDesc) return;

    if (it.reference_no && !matchedRefNo) {
      matchedRefNo = it.reference_no;
    }

    // DEDUPLICATION: An attempt is uniquely identified by its origin_id (or id).
    // Carried-over copies share the same origin_id and are skipped so they aren't counted twice.
    const attemptKey = String(it.origin_id || it.id);
    if (attemptKey && seenAttemptKeys.has(attemptKey)) {
      return;
    }
    if (attemptKey) seenAttemptKeys.add(attemptKey);

    matchingItems.push(it);

    const isCompetitive = String(it.mode || '').trim().toLowerCase().includes('competitive bidding');
    if (isCompetitive) {
      competitiveCount++;
    }
  };

  // 1. Check items in current record being edited
  if (currentRecord) {
    getRecordItems(currentRecord).forEach(checkItem);
  }

  // 2. Filter other records belonging to the same office
  const officeRecords = allRecords.filter(r => {
    if (!r || (currentRecord && r.id === currentRecord.id)) return false;
    if (offNorm && String(r.end_user || '').trim().toLowerCase() !== offNorm) return false;
    return true;
  });

  // Group approved records by fiscal year to inspect only the latest approved PPMP of each year
  const approvedByYear = new Map();
  officeRecords.filter(r => r.status === 'Completed').forEach(r => {
    const y = String(r.fiscal_year || '').trim();
    const existing = approvedByYear.get(y);
    if (!existing || (Number(r.approved_at || r.id) > Number(existing.approved_at || existing.id))) {
      approvedByYear.set(y, r);
    }
  });

  approvedByYear.forEach(r => {
    getRecordItems(r).forEach(checkItem);
  });

  // Also check draft records
  officeRecords.filter(r => r.status !== 'Completed').forEach(r => {
    getRecordItems(r).forEach(checkItem);
  });

  if (!matchedRefNo && competitiveCount === 0) return null;

  return {
    reference_no: matchedRefNo,
    competitiveCount,
    totalEntries: matchingItems.length
  };
}

export function updatePriorFailedBiddingRemarks(records, targetRefNo) {
  if (!records || !targetRefNo) return records;
  const isArrayOfRecords = Array.isArray(records) && records[0] && (records[0].items || records[0].ppmp_no);

  const allCompetitive = [];
  if (isArrayOfRecords) {
    records.forEach(r => {
      getRecordItems(r).forEach(it => {
        if (it && it.reference_no === targetRefNo && String(it.mode || '').toLowerCase().includes('competitive bidding')) {
          allCompetitive.push(it);
        }
      });
    });
  } else if (Array.isArray(records)) {
    records.forEach(it => {
      if (it && it.reference_no === targetRefNo && String(it.mode || '').toLowerCase().includes('competitive bidding')) {
        allCompetitive.push(it);
      }
    });
  }

  if (allCompetitive.length >= 1) {
    const it1 = allCompetitive[0];
    const s1 = String(it1.remarks || '');
    if (!s1.toLowerCase().includes('1st failure')) {
      it1.remarks = s1.trim() ? `${s1.trim()} [1st Failure]` : '[1st Failure]';
    }
  }
  if (allCompetitive.length >= 2) {
    const it2 = allCompetitive[1];
    const s2 = String(it2.remarks || '');
    if (!s2.toLowerCase().includes('2nd failure')) {
      it2.remarks = s2.trim() ? `${s2.trim()} [2nd Failure]` : '[2nd Failure]';
    }
  }
  return records;
}

export function tagFailedAttempts(records, description, office) {
  const normDesc = normalizeDescription(description);
  const offNorm = String(office || '').trim().toLowerCase();
  if (!normDesc) return records;

  let failureCount = 0;
  return (records || []).map(r => {
    if (offNorm && String(r.end_user || '').trim().toLowerCase() !== offNorm) return r;
    const updatedItems = getRecordItems(r).map(it => {
      const itDesc = normalizeDescription(it.project_description);
      if (itDesc === normDesc && String(it.mode || '').toLowerCase().includes('competitive bidding')) {
        failureCount++;
        const tag = failureCount === 1 ? '[1st Failure]' : '[2nd Failure]';
        const str = String(it.remarks || '');
        let newRemarks = str;
        if (!str.toLowerCase().includes(tag.toLowerCase())) {
          newRemarks = str.trim() ? `${str.trim()} ${tag}` : tag;
        }
        return { ...it, remarks: newRemarks };
      }
      return it;
    });
    return { ...r, items: updatedItems };
  });
}

export function getLatestApprovedPpmpForOffice(office, fiscalYear) {
  if (!office || !fiscalYear) return null;
  const year = String(fiscalYear).trim();
  const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
  const offNorm = String(office).trim().toLowerCase();

  const approved = all.filter(r =>
    r && r.status === 'Completed' &&
    String(r.end_user || '').trim().toLowerCase() === offNorm &&
    String(r.fiscal_year || '').trim() === year
  );

  if (approved.length === 0) return null;

  approved.sort((a, b) => {
    const numA = parseInt(a.ppmp_no, 10) || 0;
    const numB = parseInt(b.ppmp_no, 10) || 0;
    if (numB !== numA) return numB - numA;
    return (Number(b.approved_at) || Number(b.id) || 0) - (Number(a.approved_at) || Number(a.id) || 0);
  });

  return approved[0];
}

// Kept for existing callers; same behavior as carryOverItems (ids start at newBaseTimestamp + 1).
export function clonePpmpItemsForCarryOver(sourceRecord, newBaseTimestamp = Date.now()) {
  return carryOverItems(sourceRecord, newBaseTimestamp + 1);
}


// APP Storage & Helpers
export function getAllAppRecords() {
  try {
    return JSON.parse(localStorage.getItem('app_records')) || [];
  } catch {
    return [];
  }
}

export function getAppRecord(fiscalYear) {
  const all = getAllAppRecords();
  const year = String(fiscalYear || new Date().getFullYear());
  let rec = all.find(r => String(r.fiscal_year) === year);
  if (!rec) {
    rec = {
      id: 'app_' + year,
      fiscal_year: year,
      status: 'Draft',
      currentApproverRole: null,
      submitted_by: null,
      submitted_at: null,
      ard_approved_by: null,
      ard_approved_at: null,
      approved_by: null,
      approved_at: null,
      returned_for_revision: false,
      rejected_by: null,
      rejected_at: null,
      remarksHistory: []
    };
  }
  return rec;
}

export function saveAppRecord(record) {
  const all = getAllAppRecords();
  const idx = all.findIndex(r => String(r.fiscal_year) === String(record.fiscal_year));
  if (idx !== -1) all[idx] = record;
  else all.push(record);
  localStorage.setItem('app_records', JSON.stringify(all));
}

export function isAppFinal(year) {
  return getAppRecord(year).status === 'Completed';
}

// An APP only exists because approved PPMPs back it. When the last approved PPMP of a fiscal
// year is deleted, a saved APP that is Final / under review for that year is stale (it would
// still say "Final" with a Download PDF button but have nothing to compile), so drop it.
// Draft APPs are left alone. Returns the fiscal years that were reset.
export function pruneOrphanAppRecords() {
  let records = [];
  try {
    const parsed = JSON.parse(localStorage.getItem('procurement_records'));
    records = Array.isArray(parsed) ? parsed : [];
  } catch {
    records = [];
  }
  const backedYears = new Set(
    records
      .filter((r) => r && r.status === 'Completed')
      .map((r) => String(r.fiscal_year).trim())
  );

  const apps = getAllAppRecords();
  const removedYears = [];
  const kept = apps.filter((a) => {
    const year = String(a.fiscal_year).trim();
    const orphan = a.status && a.status !== 'Draft' && !backedYears.has(year);
    if (orphan) removedYears.push(year);
    return !orphan;
  });

  if (removedYears.length) {
    localStorage.setItem('app_records', JSON.stringify(kept));
  }
  return removedYears;
}

export function getLatestApprovedPpmpPerOffice(records, fiscalYear) {
  const latestByOffice = new Map();
  const yStr = fiscalYear != null ? String(fiscalYear).trim() : null;

  (records || []).forEach(r => {
    if (!r || r.status !== 'Completed') return;
    if (yStr && String(r.fiscal_year).trim() !== yStr) return;

    const office = r.end_user || 'N/A';
    const curr = latestByOffice.get(office);
    const currOrder = curr ? (Number(curr.approved_at) || Number(curr.id) || 0) : -1;
    const rOrder = Number(r.approved_at) || Number(r.id) || 0;

    if (!curr || rOrder > currOrder) {
      latestByOffice.set(office, r);
    }
  });

  return Array.from(latestByOffice.values());
}

// ---- New request / bulk import: which PPMP does a new entry go to? ----

// Latest PPMP (highest number) of an office for one fiscal year. PPMP numbers restart every
// fiscal year, so FY 2026 can reach No. 4 while FY 2027 starts again at No. 1.
export function findLatestPpmp(records, office, fiscalYear) {
  const off = String(office || '').trim().toLowerCase();
  const year = String(fiscalYear || '').trim();
  let best = null;
  (records || []).forEach((r) => {
    if (!r || String(r.end_user || '').trim().toLowerCase() !== off) return;
    if (String(r.fiscal_year).trim() !== year) return;
    const n = parseInt(r.ppmp_no, 10) || 0;
    const bestN = best ? (parseInt(best.ppmp_no, 10) || 0) : -1;
    if (!best || n > bestN || (n === bestN && Number(r.id) > Number(best.id))) best = r;
  });
  return best;
}

// Keep the latest approved PPMP available as the source for the next version.
// A newer draft may still be deleted, so it does not replace this carryover source.
export function isLatestApprovedCarryoverSource(record, records) {
  if (!record || getPpmpStatus(record) !== 'Completed') return false;

  const office = String(record.end_user || '').trim().toLowerCase();
  const year = String(record.fiscal_year || '').trim();
  let latest = null;
  (records || []).forEach((r) => {
    if (!r || getPpmpStatus(r) !== 'Completed') return;
    if (String(r.end_user || '').trim().toLowerCase() !== office) return;
    if (String(r.fiscal_year || '').trim() !== year) return;

    const number = parseInt(r.ppmp_no, 10) || 0;
    const latestNumber = latest ? (parseInt(latest.ppmp_no, 10) || 0) : -1;
    if (!latest || number > latestNumber || (number === latestNumber && Number(r.id) > Number(latest.id))) {
      latest = r;
    }
  });

  return String(latest?.id) === String(record.id);
}

// What "New Request" / bulk import does for an office + fiscal year, based on its latest PPMP:
//   no PPMP yet            -> 'new'          create PPMP No. 1
//   latest is a Draft      -> 'append'       add the entries to that Draft (no new PPMP)
//   latest is approved     -> 'new-version'  create the next PPMP and carry over the approved one
//   latest is under review -> 'blocked'      nothing can be added until it is approved or returned
export function getNewRequestTarget(records, office, fiscalYear) {
  const latest = findLatestPpmp(records, office, fiscalYear);
  if (!latest) return { mode: 'new', record: null };
  const status = getPpmpStatus(latest);
  if (status === 'Draft') return { mode: 'append', record: latest };
  if (status === 'Completed') return { mode: 'new-version', record: latest };
  return { mode: 'blocked', record: latest };
}

export function newRequestBlockedMessage(record, fiscalYear) {
  return `PPMP No. ${record.ppmp_no} for FY ${fiscalYear} is still under review, so nothing new can be added until it is approved or returned.`;
}

// Items a new PPMP inherits from the previous version (No. 1 -> No. 2). Copies get new ids but keep
// reference_no (so budgets count them once) and origin_id (so the failed-bidding check counts them once).
export function carryOverItems(previous, idStart = Date.now() + 1) {
  if (!previous) return [];
  return getRecordItems(previous).map((it, i) => ({
    ...JSON.parse(JSON.stringify(it)),
    id: idStart + i,
    origin_id: it.origin_id || it.id,
    carried_over_from: it.carried_over_from || previous.ppmp_no
  }));
}

const sameOffice = (a, b) => {
  const norm = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) !== '' && norm(a) === norm(b);
};

export function canSessionActOnRecord(record, session) {
  if (!session || !session.canApprove || !record) return false;
  if (getPpmpStatus(record) !== 'For Approval') return false;
  if (record.dtms_track && (
    !record.dtms_signing_complete ||
    record.dtms_signed_file_track !== record.dtms_track
  )) return false;
  if (record.currentApproverRole !== session.stage) return false;
  if (session.stage === 'HEAD') return sameOffice(record.end_user, session.headOf);
  return true;
}

export function formatApprovalDate(timestamp) {
  const n = Number(timestamp);
  if (!n) return '';
  return new Date(n).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatApprovalDateTime(timestamp) {
  const n = Number(timestamp);
  if (!n) return '';
  return new Date(n).toLocaleString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

const PPMP_YEAR_COUNTER_KEY = 'ppmp_number_counters_by_year';

export function ppmpYearCounterKey(office, fiscalYear) {
  return (office || 'N/A') + '__' + String(fiscalYear || '').trim();
}

export function readPpmpYearCounters() {
  try {
    return JSON.parse(localStorage.getItem(PPMP_YEAR_COUNTER_KEY)) || {};
  } catch {
    return {};
  }
}

export function recordApprovedPpmpNumber(record) {
  if (!record) return;
  const number = parseInt(record.ppmp_no, 10);
  const year = String(record.fiscal_year || '').trim();
  if (isNaN(number) || !year) return;

  const office = record.end_user || 'N/A';
  const key = ppmpYearCounterKey(office, year);
  const counters = readPpmpYearCounters();
  if (number > (Number(counters[key]) || 0)) {
    counters[key] = number;
    try {
      localStorage.setItem(PPMP_YEAR_COUNTER_KEY, JSON.stringify(counters));
    } catch (e) {
      console.warn('Could not save PPMP number counter', e);
    }
  }
}

// Why this PPMP cannot be submitted yet, or null when it can. Used before anything is sent to DTMS.
export function getPpmpSubmitError(record) {
  if (!record) return 'Record not found.';
  if (!isPpmpDraft(record)) return 'This PPMP was already submitted for approval.';
  const missingDocs = getItemsMissingDocuments(record);
  if (missingDocs.length > 0) return buildMissingDocsMessage(missingDocs);
  const modeMismatch = getItemsBudgetModeMismatch(record);
  if (modeMismatch.length > 0) return buildBudgetMismatchMessage(modeMismatch);
  return null;
}

// extra: optional fields saved in the same write as the status change (e.g. { dtms_track }).
export function submitPpmpForApproval(recordId, session, extra = null) {
  if (!session) return { success: false, error: 'Not authenticated.' };
  const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
  const idx = all.findIndex(r => r.id === recordId);
  if (idx === -1) return { success: false, error: 'Record not found.' };

  const record = all[idx];
  const problem = getPpmpSubmitError(record);
  if (problem) return { success: false, error: problem };

  record.status = 'For Approval';
  record.submitted_at = Date.now();
  record.returned_for_revision = false;
  record.submission_round = (Number(record.submission_round) || 1) + (record.rejected_at ? 1 : 0);

  record.currentApproverRole = 'HEAD';

  record.submitted_by = {
    name: session.roleName,
    role: session.role,
    email: session.email
  };
  if (extra) Object.assign(record, extra);

  try {
    localStorage.setItem('procurement_records', JSON.stringify(all));
  } catch (err) {
    return { success: false, error: 'Could not submit for approval — please try again.' };
  }

  return {
    success: true,
    record,
    message: `PPMP No. ${record.ppmp_no} submitted for approval.`
  };
}

export function performPpmpReviewAction(recordId, action, remarksText, session) {
  if (!session || !session.canApprove) {
    return { success: false, error: 'Only an authorized approver can review a PPMP.' };
  }
  const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
  const idx = all.findIndex(r => r.id === recordId);
  if (idx === -1) return { success: false, error: 'Record not found.' };

  const record = all[idx];
  if (getPpmpStatus(record) !== 'For Approval') {
    return { success: false, error: 'This PPMP must be submitted for approval before it can be reviewed.' };
  }
  if (!canSessionActOnRecord(record, session)) {
    return { success: false, error: 'This PPMP is not waiting for your approval.' };
  }

  if (!['approve', 'reject', 'comment'].includes(action)) {
    return { success: false, error: 'Unknown review action.' };
  }

  const remarks = (remarksText || '').trim();
  if ((action === 'reject' || action === 'comment') && !remarks) {
    return { success: false, error: 'Please enter remarks first.' };
  }

  // 1. Log the decision in remarksHistory
  if (!Array.isArray(record.remarksHistory)) record.remarksHistory = [];
  record.remarksHistory.push({
    stage: session.stage,
    role: session.role,
    name: session.roleName,
    action: action === 'approve' ? 'approved' : (action === 'reject' ? 'rejected' : 'remark'),
    remarks: remarks || 'Approved.',
    round: Number(record.submission_round) || 1,
    date: new Date().toLocaleDateString(),
    at: Date.now()
  });

  let message = '';

  if (action === 'comment') {
    message = `Remark added to PPMP No. ${record.ppmp_no}.`;
  } else if (action === 'reject') {
    record.status = 'Draft';
    record.currentApproverRole = null;
    record.returned_for_revision = true;
    record.rejected_at = Date.now();
    record.rejected_by = {
      name: session.roleName,
      role: session.role,
      email: session.email,
      stage: session.stage
    };
    if (record.dtms_track) {
      record.dtms_rejected_track = record.dtms_track;
      record.dtms_track = null;
      record.dtms_signing_complete = false;
    }
    message = `PPMP No. ${record.ppmp_no} rejected and returned to the requesting office.`;
  } else {
    // Approve
    const currentIdx = APPROVAL_CHAIN.findIndex(step => step.role === record.currentApproverRole);
    if (currentIdx > -1 && currentIdx < APPROVAL_CHAIN.length - 1) {
      const next = APPROVAL_CHAIN[currentIdx + 1];
      record.currentApproverRole = next.role;
      message = `PPMP No. ${record.ppmp_no} approved and forwarded to ${next.label}.`;
    } else {
      record.status = 'Completed';
      record.currentApproverRole = 'None';
      record.returned_for_revision = false;
      record.is_indicative = 'Final';
      record.approved_at = Date.now();
      recordApprovedPpmpNumber(record);
      record.approved_by = {
        name: session.roleName,
        role: session.role,
        email: session.email
      };
      message = `PPMP No. ${record.ppmp_no} fully approved and marked Final.`;
    }
  }

  try {
    localStorage.setItem('procurement_records', JSON.stringify(all));
  } catch (err) {
    return { success: false, error: 'Could not save review decision.' };
  }

  return { success: true, record, message, action };
}