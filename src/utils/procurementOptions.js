// ============================================================
// Single source of truth for the dropdown/list values used by
// RequestModal, PpmpExpanded (inline editor) and bulkImport.
// Edit them HERE only — the form and the Excel import then
// can never disagree about what is allowed.
// ============================================================

export const PROJECT_TYPES = ['Goods', 'Infrastructure', 'Consulting Services'];

export const GENERAL_REQUIREMENT_OPTIONS = [
  'General Requirements',
  'Miscellaneous',
  'Common Supplies and Equipment'
];

export const EXPENSE_CLASS_OPTIONS = ['MOOE', 'CO', 'N/A'];

// Set automatically (never picked by hand) when an item has two earlier
// competitive biddings — RA 12009 Sec. 33.
export const FAILED_BIDDING_MODE = 'Negotiated Procurement – Two Failed Biddings';
export const NEGOTIATED_CRITERIA = 'Negotiated';

// Criteria a person may pick. 'Negotiated' is deliberately NOT here:
// it is only ever assigned together with FAILED_BIDDING_MODE.
export const BID_CRITERIA_OPTIONS = [
  'Lowest Calculated Responsive Bid (LCRB)',
  'Most Economically Advantageous Responsive Bid (MEARB)',
  'Quality-Based Evaluation (QBE)',
  'Quality-Cost Based Evaluation (QCBE)',
  'Fixed Budget Selection (FBS)',
  'Least-Cost Selection (LCS)',
  'N/A'
];

// NOTE: this is the longer list that was in bulkImport.js. Compare it with
// the options in your ORIGINAL HTML form and trim/extend it once, here.
export const STRATEGY_OPTIONS = [
  'Multi-Year Contracting',
  'Subcontracting',
  'Life Cycle Assessment (LCA) and LCCA',
  'Framework Agreement',
  'Early Procurement Activities',
  'Design-and-Build Scheme for Infrastructure',
  'Engagement of a Procurement Agent',
  'Pooled Procurement Section 17',
  'Renewal of Regular and Recurring Services',
  'Warehousing and Inventory Activities',
  'N/A'
];
