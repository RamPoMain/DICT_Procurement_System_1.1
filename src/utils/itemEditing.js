// ============================================================
// Inline item editing for the Entries dropdown.
// Ported from the "Inline item editing" section of the original
// dashboard-logic.js. Pure helpers + one function that writes to
// localStorage (saveRecordItems).
// ============================================================
import {
  PROCUREMENT_MODE_RULES,
  getRecordItems,
  isBracketMismatch,
  isBracketMode,
  exceedsModeCeiling,
  budgetBracketMessage,
  isPpmpDraft,
  claimEntryRef,
  findExistingReferenceInfo,
  updatePriorFailedBiddingRemarks,
  tagFailedAttempts
} from './procurementRules.js';

// ------------------------------------------------------------
// Option lists
// ------------------------------------------------------------
export const PROJECT_TYPES = ['Consulting Services', 'Goods', 'Infrastructure'];

export const GENERAL_REQUIREMENT_CHOICES = [
  'General Requirements',
  'Miscellaneous',
  'Common Supplies and Equipment'
];

export const MODE_GROUPS = [
  { label: 'Competitive Mode', options: ['Competitive Bidding'] },
  {
    label: 'Alternative Modes',
    options: [
      'Limited Source Bidding', 'Direct Contracting', 'Repeat Order', 'Shopping',
      'Small Value Procurement (SVP)', 'Direct Acquisition', 'Competitive Dialogue',
      'Negotiated Procurement'
    ]
  }
];

export const FAILED_BIDDING_MODE = 'Negotiated Procurement – Two Failed Biddings';

export const CRITERIA_OPTIONS = [
  'Lowest Calculated Responsive Bid (LCRB)',
  'Most Economically Advantageous Responsive Bid (MEARB)',
  'Most Advantageous Responsive Bid (MARB) / HRRB / SRRB',
  'Lowest Comparative or Competitive Responsive Bid (LCCRB)',
  'Negotiated',
  'N/A'
];

export const STRATEGY_OPTIONS = [
  'Life Cycle Assessment (LCA) and LCCA', 'Subcontracting', 'Multi-Year Contracting',
  'Design-and-Build Scheme for Infrastructure', 'Engagement of a Procurement Agent',
  'Use of Framework Agreement Section', 'Pooled Procurement Section 17',
  'Renewal of Regular and Recurring Services', 'Warehousing and Inventory Activities',
  'N/A'
];

// Fields that can show a validation message.
export const EDITABLE_FIELDS = [
  'project_description', 'object_name', 'project_type', 'quantity_size', 'mode',
  'pre_procurement', 'bid_evaluation_criteria', 'start_date', 'bid_opening_date',
  'notice_of_award_date', 'end_date', 'delivery_period', 'fund_source', 'budget',
  'strategies', 'remarks'
];

const norm = (s) => String(s || '').replace(/[–—]/g, '-').trim();
const MODE_VALUES = [
  ...MODE_GROUPS.flatMap((g) => g.options),
  FAILED_BIDDING_MODE,
  'Negotiated Procurement - Two Failed Biddings'
].map(norm);

// "Two Failed Biddings" items are automated: mode and criteria are locked.
export const isFailedBiddingItem = (item) =>
  String(item?.mode || '').toLowerCase().includes('failed biddings');

// ------------------------------------------------------------
// Items
// ------------------------------------------------------------
let idSeq = 0;
export const newItemId = () => { idSeq += 1; return Date.now() + idSeq; };

export function blankItem() {
  return {
    id: newItemId(),
    project_description: '', object_name: '', project_type: '', quantity_size: '', mode: '',
    pre_procurement: '', bid_evaluation_criteria: '', start_date: '',
    bid_opening_date: '', notice_of_award_date: '', end_date: '',
    delivery_period: '', fund_source: '', budget: '', strategies: [],
    supporting_documents: [], general_requirements: '', remarks: ''
  };
}

// Deep copy of the saved items, making sure each one has an id to key edits by.
export function cloneItemsForEdit(record) {
  return JSON.parse(JSON.stringify(getRecordItems(record))).map((it) =>
    it.id == null ? { ...it, id: newItemId() } : it
  );
}

// Attachments are megabytes of base64 for old records, so compare lengths.
export function itemsSignature(items) {
  return JSON.stringify(items, (key, value) =>
    key === 'dataUrl' ? (value ? value.length : 0) : value
  );
}

// ------------------------------------------------------------
// Budget + dates
// ------------------------------------------------------------
// Digits and one decimal point, at most 2 decimals.
export function cleanBudgetInput(raw) {
  let value = String(raw).replace(/[^0-9.]/g, '');
  const parts = value.split('.');
  if (parts.length > 2) value = parts[0] + '.' + parts.slice(1).join('');
  const bits = value.split('.');
  if (bits.length === 2) value = bits[0] + '.' + bits[1].slice(0, 2);
  return value;
}

export function parseBudgetInput(raw) {
  const cleaned = String(raw == null ? '' : raw).replace(/[,\s\u20B1]/g, '').replace(/^P/i, '');
  if (cleaned === '' || !/^\d*\.?\d+$|^\d+\.$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

export function nextDay(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d)) return '2000-01-01';
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const MILESTONES = ['start_date', 'bid_opening_date', 'notice_of_award_date', 'end_date'];

// Earliest date a milestone may take: the nearest earlier milestone that has a date.
export function dateFloor(item, field) {
  const idx = MILESTONES.indexOf(field);
  for (let i = idx - 1; i >= 0; i -= 1) {
    const v = item && item[MILESTONES[i]];
    if (v) return v;
  }
  return '2000-01-01';
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== value) return false;
  const y = d.getUTCFullYear();
  return y >= 2000 && y <= 2100;
}

// ------------------------------------------------------------
// Validation: the same rules the request form enforces.
// Returns { field: 'message' } for everything wrong with one item.
// ------------------------------------------------------------
export function validateItem(item) {
  const errors = {};
  const text = (key) => String(item[key] == null ? '' : item[key]).trim();

  if (!text('project_description')) errors.project_description = 'Project description is required.';

  if (!text('project_type')) errors.project_type = 'Select a type of project.';
  else if (!PROJECT_TYPES.includes(text('project_type'))) errors.project_type = 'Choose a type from the list.';

  if (!text('quantity_size')) errors.quantity_size = 'Quantity and size is required.';
  else if (text('quantity_size').length < 3) errors.quantity_size = 'Please provide a more detailed quantity or size.';

  if (!text('mode')) errors.mode = 'Select a mode of procurement.';
  else if (!MODE_VALUES.includes(norm(text('mode')))) errors.mode = 'Choose a mode from the list.';

  if (!text('pre_procurement')) errors.pre_procurement = 'Select Yes or No.';
  else if (!['Yes', 'No'].includes(text('pre_procurement'))) errors.pre_procurement = 'Choose Yes or No.';

  if (!text('object_name')) errors.object_name = 'Object Code is required.';
  else if (!/^\d+$/.test(text('object_name'))) errors.object_name = 'Object Code must be numbers only.';

  // Criteria is locked to "Negotiated" for automated failed-bidding items.
  if (!isFailedBiddingItem(item)) {
    if (!text('bid_evaluation_criteria')) errors.bid_evaluation_criteria = 'Select the criteria for bid evaluation.';
    else if (!CRITERIA_OPTIONS.includes(text('bid_evaluation_criteria'))) errors.bid_evaluation_criteria = 'Choose a criteria from the list.';
  }

  // Dates: present, real, in range and in order
  // (advertisement -> bid opening -> notice of award -> contract signing -> delivery).
  const milestones = [
    ['start_date', 'advertisement/posting date', 'Advertisement/posting date', 'the advertisement/posting date'],
    ['bid_opening_date', 'submission/opening of bids date', 'Submission/opening of bids', 'the submission/opening of bids'],
    ['notice_of_award_date', 'notice of award date', 'Notice of award', 'the notice of award'],
    ['end_date', 'contract signing date', 'Contract signing', 'the contract signing']
  ];
  let prev = null;
  milestones.forEach(([key, label, title, ref]) => {
    const v = text(key);
    if (!v) { errors[key] = `Select the ${label}.`; return; }
    if (!isRealDate(v)) { errors[key] = 'Enter a valid date (2000-2100).'; return; }
    if (prev && new Date(v) < new Date(prev.value)) errors[key] = `${title} cannot be earlier than ${prev.ref}.`;
    prev = { value: v, ref };
  });

  const end = text('end_date');
  const delivery = text('delivery_period');
  if (!delivery) errors.delivery_period = 'Select the expected delivery/implementation date.';
  else if (!isRealDate(delivery)) errors.delivery_period = 'Enter a valid date (2000-2100).';
  if (!errors.end_date && !errors.delivery_period && new Date(delivery) <= new Date(end)) {
    errors.delivery_period = 'Delivery must be after the end of procurement activity.';
  }

  if (!text('fund_source')) errors.fund_source = 'Source of funds is required.';
  else if (text('fund_source').length < 2) errors.fund_source = 'Please provide a valid fund source.';

  // Budget: a real number above zero, and consistent with the mode.
  const budgetNumber = parseBudgetInput(text('budget'));
  if (!text('budget')) errors.budget = 'Estimated budget is required.';
  else if (isNaN(budgetNumber) || budgetNumber <= 0) errors.budget = 'Enter an amount greater than zero.';

  const modeVal = text('mode');
  const projType = text('project_type');
  const rule = PROCUREMENT_MODE_RULES[modeVal];
  if (rule && budgetNumber > 0) {
    if (projType && rule.allowedTypes && !rule.allowedTypes.includes(projType)) {
      errors.mode = `"${modeVal}" under ${rule.legalBasis} is restricted to ${rule.allowedTypes.join(' / ')}.`;
    } else if (isBracketMismatch(modeVal, budgetNumber) || exceedsModeCeiling(modeVal, budgetNumber)) {
      if (isBracketMode(modeVal)) {
        errors.mode = budgetBracketMessage(modeVal, budgetNumber);
        errors.budget = errors.mode;
      } else if (modeVal === 'Shopping') {
        errors.mode = 'Budget exceeds ₱2,000,000.00 ceiling for Shopping (RA 12009 Sec. 30).';
        errors.budget = errors.mode;
      }
    }
  }

  if (!Array.isArray(item.strategies) || item.strategies.length === 0) {
    errors.strategies = 'Select at least one procurement strategy.';
  }

  if (!text('remarks')) errors.remarks = 'Remarks are required.';
  else if (text('remarks').length < 3) errors.remarks = 'Remarks must contain at least 3 characters.';

  return errors;
}

// ------------------------------------------------------------
// Saving
// ------------------------------------------------------------
// Trims typed text, strips peso formatting from the budget and applies the
// locked values of failed-bidding items. Returns new objects.
export function normalizeItemsForSave(items) {
  return items.map((it) => {
    const out = { ...it };
    ['project_description', 'object_name', 'quantity_size', 'fund_source', 'general_requirements', 'remarks']
      .forEach((key) => { out[key] = String(out[key] == null ? '' : out[key]).trim(); });
    if (!isNaN(parseBudgetInput(out.budget))) {
      out.budget = String(out.budget).replace(/[,\s\u20B1]/g, '').replace(/^P/i, '');
    }
    if (isFailedBiddingItem(out)) out.bid_evaluation_criteria = 'Negotiated';
    return out;
  });
}

// Writes the edited items back to the record. Items typed straight into the
// dropdown get their reference number here.
export function saveRecordItems(recordId, items) {
  let all;
  try {
    all = JSON.parse(localStorage.getItem('procurement_records')) || [];
  } catch {
    all = [];
  }
  const idx = all.findIndex((r) => r.id == recordId);
  if (idx === -1) return { success: false, error: 'Record not found.' };

  const original = all[idx];
  if (!isPpmpDraft(original)) {
    return {
      success: false,
      locked: true,
      error: 'This PPMP was submitted or approved while you were editing, so it is now read-only.'
    };
  }

  const next = items.map((it) => ({ ...it }));
  // claimEntryRef reads this copy, so two new items of the same type
  // get different numbers.
  const pool = all.map((r, i) => (i === idx ? { ...r, items: next } : r));

  next.forEach((item) => {
    const info = findExistingReferenceInfo(
      item.project_description, item.project_type, original, original.end_user
    );
    if (info && info.reference_no) {
      if (!item.reference_no) item.reference_no = info.reference_no;
      if (info.competitiveCount >= 2) {
        item.mode = FAILED_BIDDING_MODE;
        item.bid_evaluation_criteria = 'Negotiated';
        const autoRemark = '[Negotiated Procurement – Two Failed Biddings (RA 12009 Sec. 33)]';
        if (!String(item.remarks || '').toLowerCase().includes('two failed biddings')) {
          item.remarks = item.remarks ? `${item.remarks.trim()} ${autoRemark}` : autoRemark;
        }
      }
    }
    if (!item.reference_no) {
      item.reference_no = claimEntryRef(pool, item.project_type, original.fiscal_year);
    }
  });

  all[idx] = { ...original, items: next };

  next.forEach((it) => {
    if (it.reference_no) {
      all = updatePriorFailedBiddingRemarks(all, it.reference_no);
    }
    if (isFailedBiddingItem(it)) {
      all = tagFailedAttempts(all, it.project_description, original.end_user);
    }
  });
  try {
    localStorage.setItem('procurement_records', JSON.stringify(all));
  } catch {
    return {
      success: false,
      error: 'Could not save - the attached files are too large for browser storage. Remove or shrink an attachment and try again.'
    };
  }
  return { success: true, message: 'PPMP items saved.' };
}
