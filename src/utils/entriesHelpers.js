// Entries-page helpers ported from the original dashboard-logic.js.
// Pure functions only (plus deleteRecordById, which writes to localStorage).
import {
  getRecordItems,
  getPpmpStatus,
  isPpmpDraft,
  parseBudgetNumber,
  formatPesoExact,
  calculateDeduplicatedBudget,
  itemHasSupportingDocument,
  getAppRecord,
  isAppFinal,
  isLatestApprovedCarryoverSource
} from './procurementRules.js';
import { canActOnApp } from './dashboardHelpers.js';

export const GENERAL_REQUIREMENT_OPTIONS = [
  'General Requirements',
  'Miscellaneous',
  'Common Supplies and Equipment'
];

// ------------------------------------------------------------
// Row summaries
// ------------------------------------------------------------
export function getRecordDescriptionSummary(record) {
  const items = getRecordItems(record);
  if (items.length === 0) return 'N/A';
  const first = items[0].project_description || items[0].quantity_size || 'N/A';
  const extra = items.length - 1;
  return extra > 0 ? `${first} (+${extra} more item${extra === 1 ? '' : 's'})` : first;
}

export function getRecordProjectTypeSummary(record) {
  const types = [...new Set(getRecordItems(record).map((i) => i.project_type).filter(Boolean))];
  if (types.length === 0) return 'N/A';
  return types.length === 1 ? types[0] : 'Mixed';
}

export const getRecordTotalBudget = (record) =>
  calculateDeduplicatedBudget(getRecordItems(record));

// ------------------------------------------------------------
// Main table: filters + numbering
// ------------------------------------------------------------
export const ENTRY_FILTER_DEFAULTS = {
  status: 'All',
  indicative: 'All',
  type: 'All',
  category: 'All',
  office: 'All',
  search: ''
};

export function filterEntryRecords(records, f) {
  const q = f.search.trim().toLowerCase();
  return records.filter((record) => {
    const items = getRecordItems(record);
    if (f.status !== 'All' && getPpmpStatus(record) !== f.status) return false;
    if (f.indicative !== 'All' && record.is_indicative !== f.indicative) return false;
    if (f.type !== 'All' && !items.some((i) => i.project_type === f.type)) return false;
    if (f.category !== 'All' && !items.some((i) => i.general_requirements === f.category)) return false;
    if (f.office !== 'All' && record.end_user !== f.office) return false;
    if (!q) return true;

    const haystack = [
      record.ppmp_no,
      record.end_user,
      record.fiscal_year,
      ...items.map((i) => i.project_description),
      ...items.map((i) => i.project_type),
      ...items.map((i) => i.mode),
      ...items.map((i) => i.general_requirements)
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

// Only approved (Completed) PPMPs get a number, counted per office in approval
// order. Never shifts because of filters or new requests.
export function getApprovedEntryNumbers(records) {
  const numbers = new Map();
  const perOffice = new Map();
  records
    .filter((r) => r.status === 'Completed')
    .sort((a, b) =>
      (Number(a.approved_at) || Number(a.id)) - (Number(b.approved_at) || Number(b.id)))
    .forEach((r) => {
      const office = r.end_user || 'N/A';
      const next = (perOffice.get(office) || 0) + 1;
      perOffice.set(office, next);
      numbers.set(String(r.id), next);
    });
  return numbers;
}

export const getOffices = (records) =>
  [...new Set(records.map((r) => r.end_user).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// ------------------------------------------------------------
// Header APP button
// ------------------------------------------------------------
export function getDefaultAppFiscalYear(records) {
  const years = [...new Set(
    (records || [])
      .filter((r) => r && r.status === 'Completed' && /^\d{4}$/.test(String(r.fiscal_year).trim()))
      .map((r) => String(r.fiscal_year).trim())
  )].sort();
  if (years.length === 0) return String(new Date().getFullYear());
  return years.find((y) => !isAppFinal(y)) || years[years.length - 1];
}

export function getAppButtonInfo(user, records) {
  const year = getDefaultAppFiscalYear(records);
  const app = getAppRecord(year);
  let label = 'Annual Procurement Plan (APP)';

  // Action labels only appear once the previous DTMS signature is back (canActOnApp).
  if (user?.role === 'ARD' && canActOnApp(app, user)) {
    label = `Review APP FY ${year} (Action Needed)`;
  } else if (user?.role === 'RD' && canActOnApp(app, user)) {
    label = `Review APP FY ${year} (Final Action)`;
  } else if (app.status === 'Completed') {
    label = `Final APP FY ${year} (Approved)`;
  } else if (app.status === 'For Approval') {
    label = `APP FY ${year} (In Review)`;
  } else if (app.returned_for_revision) {
    label = `APP FY ${year} (Returned)`;
  }
  return { year, label };
}

// ------------------------------------------------------------
// Item filter inside the expanded PPMP dropdown
// ------------------------------------------------------------
export const ITEM_FILTER_DEFAULTS = { search: '', type: 'All', category: 'All', mode: 'All', docs: 'All' };

export const isItemFilterActive = (f) =>
  !!(f.search.trim() || f.type !== 'All' || f.category !== 'All' || f.mode !== 'All' || f.docs !== 'All');

// showCS = Criteria/Strategies/Object code/Ref are only searchable while the
// PPMP is a Draft (they are hidden from the table once submitted).
function itemHaystack(item, showCS) {
  const docNames = Array.isArray(item.supporting_documents)
    ? item.supporting_documents.map((d) => d.name || '')
    : [];
  return [
    item.project_description, showCS ? item.object_name : '', item.project_type, item.quantity_size, item.mode,
    item.pre_procurement, showCS ? item.bid_evaluation_criteria : '', item.fund_source,
    item.remarks, item.general_requirements, item.start_date, item.bid_opening_date,
    item.notice_of_award_date, item.end_date, item.delivery_period,
    formatPesoExact(parseBudgetNumber(item.budget)),
    showCS ? (Array.isArray(item.strategies) ? item.strategies.join(' ') : item.strategies) : '',
    docNames.join(' '),
    showCS ? item.reference_no : ''
  ].map((v) => String(v == null ? '' : v)).join(' ').toLowerCase();
}

export function itemMatchesFilter(item, f, showCS) {
  const category = String(item.general_requirements || '');
  const terms = f.search.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = terms.length ? itemHaystack(item, showCS) : '';
  return (
    (f.type === 'All' || item.project_type === f.type) &&
    (f.category === 'All' || (f.category === '__none__' ? category === '' : category === f.category)) &&
    (f.mode === 'All' || item.mode === f.mode) &&
    (f.docs === 'All' || (itemHasSupportingDocument(item) ? 'with' : 'missing') === f.docs) &&
    terms.every((t) => hay.includes(t))
  );
}

// Option lists for the filter bar. Only values this PPMP actually uses.
export function getItemFilterOptions(items) {
  const unique = (key) =>
    [...new Set(items.map((i) => String(i[key] || '').trim()).filter(Boolean))].sort();
  const usedCategories = unique('general_requirements');
  return {
    types: unique('project_type'),
    modes: unique('mode'),
    categories: [
      ...GENERAL_REQUIREMENT_OPTIONS.filter((c) => usedCategories.includes(c)),
      ...usedCategories.filter((c) => !GENERAL_REQUIREMENT_OPTIONS.includes(c))
    ],
    hasUncategorized: items.some((i) => !String(i.general_requirements || '').trim())
  };
}

export { isPpmpDraft };

// ------------------------------------------------------------
// Delete
// ------------------------------------------------------------
export function deleteRecordById(id) {
  try {
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const target = all.find((r) => r.id == id);
    if (!target || isLatestApprovedCarryoverSource(target, all)) return false;
    localStorage.setItem('procurement_records', JSON.stringify(all.filter((r) => r.id != id)));
    return true;
  } catch {
    return false;
  }
}