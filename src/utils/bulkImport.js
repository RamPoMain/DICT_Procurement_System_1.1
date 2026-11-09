import ExcelJS from 'exceljs';
import {
  PROCUREMENT_MODE_RULES,
  STANDARD_PROCUREMENT_MODES,
  isBracketMismatch,
  exceedsModeCeiling,
  budgetBracketMessage,
  formatPesoMessage,
  claimEntryRef,
  findExistingReferenceInfo,
  tagFailedAttempts,
  getRecordItems,
  getPpmpStatus,
  isAppFinal,
  getNewRequestTarget,
  newRequestBlockedMessage,
  carryOverItems
} from './procurementRules.js';
import { getNextPpmpNumber } from './ppmpNumber.js';
import {
  PROJECT_TYPES,
  GENERAL_REQUIREMENT_OPTIONS,
  BID_CRITERIA_OPTIONS,
  STRATEGY_OPTIONS,
  FAILED_BIDDING_MODE,
  NEGOTIATED_CRITERIA
} from './procurementOptions.js';

// Re-exported so existing imports from bulkImport.js keep working.
export { GENERAL_REQUIREMENT_OPTIONS, BID_CRITERIA_OPTIONS, STRATEGY_OPTIONS };

export const TEMPLATE_SHEET = 'PPMP Items';
export const TEMPLATE_FILE = 'PPMP_Items_Template.xlsx';
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_IMPORT_ROWS = 200;

export const COLUMNS = [
  { key: 'project_description', label: 'Description', match: /description|objective/, width: 36, header: 'General Description and Objective of the Project to be Procured' },
  { key: 'object_name', label: 'Object Code', match: /^object(?!ive)/, width: 26, header: 'Object Code' },
  { key: 'project_type', label: 'Type of Project', match: /type of (the )?project/, width: 22, header: 'Type of the Project to be Procured' },
  { key: 'quantity_size', label: 'Quantity and Size', match: /quantity|size/, width: 24, header: 'Quantity and Size of the Project to be Procured' },
  { key: 'mode', label: 'Mode of Procurement', match: /\bmode\b/, width: 26, header: 'Recommended Mode of Procurement' },
  { key: 'pre_procurement', label: 'Pre-Procurement', match: /pre.?procurement/, width: 20, header: 'Pre-Procurement Conference (Yes/No)' },
  { key: 'bid_evaluation_criteria', label: 'Bid Criteria', match: /criteria/, width: 30, header: 'Criteria for Bid Evaluation' },
  { key: 'start_date', label: 'Advertisement/Posting', match: /^start|advertis|posting/, width: 22, header: 'Advertisement/Posting of IB/REI' },
  { key: 'bid_opening_date', label: 'Submission/Opening of Bids', match: /submission|opening/, width: 22, header: 'Submission/Opening of Bids' },
  { key: 'notice_of_award_date', label: 'Notice of Award', match: /notice|award/, width: 18, header: 'Notice of Award' },
  { key: 'end_date', label: 'Contract Signing', match: /^end|contract signing/, width: 18, header: 'Contract Signing' },
  { key: 'delivery_period', label: 'Delivery period', match: /delivery|implementation/, width: 22, header: 'Expected Delivery/ Implementation Period' },
  { key: 'fund_source', label: 'Source of Funds', match: /fund/, width: 18, header: 'Source of Funds' },
  { key: 'budget', label: 'Budget', match: /budget/, width: 24, header: 'Estimated Budget / Authorized Budgetary Allocation (PhP)' },
  { key: 'strategies', label: 'Strategies', match: /strateg/, width: 32, header: 'PROCUREMENT STRATEGIES AND TOOLS' },
  { key: 'supporting_documents', label: 'Supporting Docs', match: /supporting|attached/, width: 24, header: 'ATTACHED SUPPORTING DOCUMENTS', optional: true },
  { key: 'general_requirements', label: 'General Requirements', match: /general requirements|miscellaneous|common suppl/, width: 32, header: 'GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT', optional: true },
  { key: 'remarks', label: 'Remarks', match: /remark/, width: 20, header: 'REMARKS' }
];

function str(val) {
  return val == null ? '' : String(val).trim();
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function canonical(value, allowedList) {
  const v = str(value).toLowerCase();
  if (!v) return null;
  for (let i = 0; i < allowedList.length; i++) {
    if (allowedList[i].toLowerCase() === v) return allowedList[i];
  }
  return null;
}

export function toIsoDate(v) {
  if (v === '' || v == null) return null;
  let y, m, d, dt;

  if (v instanceof Date && !isNaN(v)) {
    y = v.getFullYear();
    m = v.getMonth() + 1;
    d = v.getDate();
  } else if (typeof v === 'number' && isFinite(v)) {
    // Excel serial date starting from 1899-12-30
    dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  } else {
    const s = String(v).trim();
    const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
    const us = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
    if (iso) {
      y = +iso[1];
      m = +iso[2];
      d = +iso[3];
    } else if (us) {
      y = +us[3];
      m = +us[1];
      d = +us[2];
    } else {
      return null;
    }
  }

  dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export function toBudget(v) {
  if (typeof v === 'number') {
    return isFinite(v) && v > 0 ? { number: v, text: String(v) } : null;
  }
  const cleaned = String(v == null ? '' : v)
    .replace(/[₱,\s]/g, '')
    .replace(/^php/i, '')
    .replace(/^p(?=\d)/i, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = parseFloat(cleaned);
  return num > 0 ? { number: num, text: cleaned } : null;
}

export function mapHeaders(headerRow) {
  const index = {};
  const used = {};
  let foundCount = 0;
  (headerRow || []).forEach((cell, i) => {
    const text = str(cell).toLowerCase().replace(/\s+/g, ' ');
    if (!text) return;
    for (let c = 0; c < COLUMNS.length; c++) {
      const col = COLUMNS[c];
      if (!used[col.key] && col.match.test(text)) {
        index[col.key] = i;
        used[col.key] = true;
        foundCount += 1;
        break;
      }
    }
  });
  const missing = COLUMNS.filter(col => !col.optional && index[col.key] === undefined);
  return { index, missing, foundCount };
}

export function mapHeaderBlock(upperRow, lowerRow) {
  const upper = mapHeaders(upperRow);
  const lower = mapHeaders(lowerRow);
  const index = {};
  const usedIdx = {};

  [lower.index, upper.index].forEach(source => {
    Object.keys(source).forEach(key => {
      const i = source[key];
      if (index[key] !== undefined || usedIdx[i]) return;
      index[key] = i;
      usedIdx[i] = true;
    });
  });

  const foundCount = Object.keys(index).length;
  const missing = COLUMNS.filter(col => !col.optional && index[col.key] === undefined);
  return { index, missing, foundCount };
}

export function findHeader(rows) {
  let best = null;
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const single = mapHeaders(rows[i]);
    if (single.foundCount >= 4 && (!best || single.foundCount > best.mapped.foundCount)) {
      best = { mapped: single, rowsUsed: 1, headerIndex: i };
    }
    const lowerRow = rows[i + 1];
    if (lowerRow && mapHeaders(lowerRow).foundCount >= 3) {
      const block = mapHeaderBlock(rows[i], lowerRow);
      if (block.foundCount >= 4 && (!best || block.foundCount > best.mapped.foundCount)) {
        best = { mapped: block, rowsUsed: 2, headerIndex: i };
      }
    }
  }
  return best;
}

export function validateRow(raw) {
  const errors = [];
  const item = {};

  const text = key => str(raw[key]);

  const description = text('project_description');
  if (description.length < 3) errors.push('Description is required (at least 3 characters).');
  item.project_description = description;

  const objectName = text('object_name');
  if (!objectName) errors.push('Object Code is required.');
  else if (!/^\d+$/.test(objectName)) errors.push('Object Code must be numbers only.');
  item.object_name = objectName;

  const type = canonical(raw.project_type, PROJECT_TYPES);
  if (!type) errors.push(`Type of Project must be one of: ${PROJECT_TYPES.join(', ')}.`);
  item.project_type = type || '';

  const quantity = text('quantity_size');
  if (quantity.length < 3) errors.push('Quantity and Size is required (at least 3 characters).');
  item.quantity_size = quantity;

  // Same list the form offers. "Two Failed Biddings" can NOT be typed in the file:
  // it is assigned automatically at import when the system finds two earlier
  // competitive biddings of the same project (RA 12009 Sec. 33).
  const mode = canonical(raw.mode, STANDARD_PROCUREMENT_MODES);
  if (!mode) {
    errors.push(
      /failed\s+bidding/i.test(str(raw.mode))
        ? 'Two Failed Biddings is set automatically when a project has two earlier competitive biddings. Enter the usual mode (e.g. Competitive Bidding) instead.'
        : 'Mode of Procurement is missing or not a recognized mode.'
    );
  }
  item.mode = mode || '';

  const pre = canonical(raw.pre_procurement, ['Yes', 'No']);
  if (!pre) errors.push('Pre-Procurement Conference must be Yes or No.');
  item.pre_procurement = pre || '';

  const criteria = canonical(raw.bid_evaluation_criteria, BID_CRITERIA_OPTIONS);
  if (!criteria) {
    errors.push(
      str(raw.bid_evaluation_criteria).toLowerCase() === NEGOTIATED_CRITERIA.toLowerCase()
        ? '"Negotiated" is assigned automatically together with Two Failed Biddings. Pick one of the listed criteria.'
        : 'Criteria for Bid Evaluation is missing or invalid.'
    );
  }
  item.bid_evaluation_criteria = criteria || '';

  const start = toIsoDate(raw.start_date);
  const bids = toIsoDate(raw.bid_opening_date);
  const award = toIsoDate(raw.notice_of_award_date);
  const end = toIsoDate(raw.end_date);
  const delivery = toIsoDate(raw.delivery_period);

  if (!start) errors.push('Advertisement/Posting of IB/REI date is missing or invalid (use YYYY-MM-DD).');
  if (!bids) errors.push('Submission/Opening of Bids date is missing or invalid (use YYYY-MM-DD).');
  if (!award) errors.push('Notice of Award date is missing or invalid (use YYYY-MM-DD).');
  if (!end) errors.push('Contract Signing date is missing or invalid (use YYYY-MM-DD).');
  if (!delivery) errors.push('Delivery period date is missing or invalid (use YYYY-MM-DD).');

  let earlier = null;
  [
    [start, 'Advertisement/Posting of IB/REI', 'the advertisement/posting date'],
    [bids, 'Submission/Opening of Bids', 'the submission/opening of bids'],
    [award, 'Notice of Award', 'the notice of award'],
    [end, 'Contract Signing', 'the contract signing']
  ].forEach(m => {
    if (!m[0]) return;
    if (earlier && m[0] < earlier.date) errors.push(`${m[1]} cannot be earlier than ${earlier.name}.`);
    earlier = { date: m[0], name: m[2] };
  });

  if (end && delivery && delivery <= end) {
    errors.push('Delivery period must be strictly after the Contract Signing date.');
  }

  item.start_date = start || '';
  item.bid_opening_date = bids || '';
  item.notice_of_award_date = award || '';
  item.end_date = end || '';
  item.delivery_period = delivery || '';

  const fund = text('fund_source');
  if (fund.length < 2) errors.push('Source of Funds is required.');
  item.fund_source = fund;

  const budget = toBudget(raw.budget);
  if (!budget) {
    errors.push('Budget must be a valid number greater than 0.');
  } else {
    item.budget = budget.text;

    // Same mode/budget rules as the form (RA 12009)
    if (mode && mode !== 'Negotiated Procurement') {
      const rule = PROCUREMENT_MODE_RULES[mode];
      if (rule) {
        if (type && rule.allowedTypes && !rule.allowedTypes.includes(type)) {
          errors.push(`Mode "${mode}" is restricted to ${rule.allowedTypes.join(', ')} under ${rule.legalBasis}.`);
        } else if (isBracketMismatch(mode, budget.number)) {
          errors.push(budgetBracketMessage(mode, budget.number));
        } else if (exceedsModeCeiling(mode, budget.number)) {
          errors.push(`Budget of ${formatPesoMessage(budget.number)} exceeds the allowable limit for ${mode} (${rule.legalBasis}).`);
        }
      }
    }
  }

  const strategies = [];
  const unknownStrategies = [];
  str(raw.strategies).split(/[;\n|,]+/).forEach(part => {
    const sName = part.trim();
    if (!sName) return;
    const match = canonical(sName, STRATEGY_OPTIONS);
    if (match) {
      if (!strategies.includes(match)) strategies.push(match);
    } else {
      unknownStrategies.push(sName);
    }
  });

  if (unknownStrategies.length) {
    errors.push(`Unknown strategy: ${unknownStrategies.join('; ')}.`);
  } else if (strategies.length === 0) {
    errors.push('Select at least one Procurement Strategy.');
  }
  item.strategies = strategies;

  const remarks = text('remarks');
  if (remarks.length < 3) errors.push('Remarks is required (at least 3 characters).');
  item.remarks = remarks;

  const generalReq = text('general_requirements');
  const generalMatch = generalReq ? canonical(generalReq, GENERAL_REQUIREMENT_OPTIONS) : '';
  if (generalReq && !generalMatch) {
    errors.push(`General Requirements must be one of: ${GENERAL_REQUIREMENT_OPTIONS.join(', ')} (or left blank).`);
  }
  item.general_requirements = generalMatch || '';
  item.supporting_documents = [];

  return { item: errors.length ? null : item, errors };
}

export function analyzeRows(rows) {
  if (!rows || rows.length === 0) {
    return { fatal: 'The file is empty.', ready: [], problems: [], total: 0 };
  }

  const header = findHeader(rows);
  if (!header) {
    return {
      fatal: 'The column headers were not found. Please use the downloaded template and keep its table header rows intact.',
      ready: [],
      problems: [],
      total: 0
    };
  }

  const mapped = header.mapped;
  if (mapped.missing.length) {
    return {
      fatal: `These required columns are missing: ${mapped.missing.map(c => c.label).join(', ')}. Please use the official template.`,
      ready: [],
      problems: [],
      total: 0
    };
  }

  const ready = [];
  const problems = [];
  let total = 0;

  let startRow = header.headerIndex + header.rowsUsed;
  while (startRow < rows.length) {
    const numbering = (rows[startRow] || []).map(str).filter(Boolean);
    const isNumberRow = numbering.length > 0 && numbering.every(t => /^column\s*\d+$/i.test(t));
    if (!isNumberRow) break;
    startRow++;
  }

  for (let r = startRow; r < rows.length; r++) {
    const cells = rows[r] || [];
    const lineText = str(cells[0] || cells[1] || cells[9] || '').toLowerCase();
    if (
      lineText.includes('total budget') ||
      lineText.includes('prepared by') ||
      lineText.includes('certified funds') ||
      lineText.includes('approved by') ||
      lineText.includes('endorsed by')
    ) {
      break;
    }

    const raw = {};
    let hasData = false;
    COLUMNS.forEach(col => {
      const cell = mapped.index[col.key] !== undefined ? cells[mapped.index[col.key]] : '';
      raw[col.key] = cell;
      if (str(cell) !== '') hasData = true;
    });

    if (!hasData) continue;

    total += 1;
    if (total > MAX_IMPORT_ROWS) {
      return {
        fatal: `This file contains more than ${MAX_IMPORT_ROWS} items. Please split it into smaller files.`,
        ready: [],
        problems: [],
        total
      };
    }

    const result = validateRow(raw);
    if (result.item) {
      ready.push({ rowNumber: r + 1, item: result.item });
    } else {
      problems.push({ rowNumber: r + 1, errors: result.errors });
    }
  }

  if (total === 0) {
    return {
      fatal: 'No filled-in items were found under the table headers.',
      ready: [],
      problems: [],
      total: 0
    };
  }

  return { fatal: null, ready, problems, total };
}

export async function downloadBulkTemplate({ ppmp_no, fiscal_year, end_user, is_indicative }) {
  const ppmpNo = ppmp_no || '1';
  const fiscalYear = fiscal_year || new Date().getFullYear().toString();
  const endUser = end_user || 'DICT Office';
  const isFinal = is_indicative === 'Final';
  const dateStr = new Date().toLocaleDateString('en-US');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DICT Procurement System';
  const sheet = workbook.addWorksheet(TEMPLATE_SHEET, {
    views: [{ showGridLines: true }]
  });

  sheet.columns = [
    { width: 36 }, // Col 1: Description
    { width: 26 }, // Col 2: Object Code
    { width: 22 }, // Col 3: Type
    { width: 24 }, // Col 4: Quantity
    { width: 26 }, // Col 5: Mode
    { width: 20 }, // Col 6: Pre-procurement
    { width: 28 }, // Col 7: Criteria
    { width: 22 }, // Col 8: Advertisement/Posting
    { width: 22 }, // Col 9: Bid Opening
    { width: 18 }, // Col 10: Notice of Award
    { width: 18 }, // Col 11: Contract Signing
    { width: 22 }, // Col 12: Delivery
    { width: 18 }, // Col 13: Fund Source
    { width: 24 }, // Col 14: Budget
    { width: 32 }, // Col 15: Strategies
    { width: 24 }, // Col 16: Attached Docs
    { width: 32 }, // Col 17: General Requirements
    { width: 20 }  // Col 18: Remarks
  ];

  sheet.mergeCells('A1:R1');
  const title = sheet.getCell('A1');
  title.value = `PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. ${ppmpNo}`;
  title.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF000000' } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 28;

  sheet.mergeCells('A2:R2');
  const checks = sheet.getCell('A2');
  checks.value = isFinal ? '[ ] INDICATIVE     [X] FINAL' : '[X] INDICATIVE     [ ] FINAL';
  checks.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF000000' } };
  checks.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(2).height = 20;

  sheet.getRow(3).height = 8;

  const fyCell = sheet.getCell('A4');
  fyCell.value = `Fiscal Year : ${fiscalYear}`;
  fyCell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF000000' } };
  sheet.getRow(4).height = 20;

  const euCell = sheet.getCell('A5');
  euCell.value = `End-User or Implementing Unit: ${endUser}`;
  euCell.font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF000000' } };
  sheet.getRow(5).height = 20;

  sheet.getRow(6).height = 10;

  // Group Headers (Row 7)
  sheet.mergeCells('A7:G7');
  sheet.getCell('A7').value = 'PROCUREMENT PROJECT DETAILS';

  sheet.mergeCells('H7:L7');
  sheet.getCell('H7').value = 'PROJECTED TIMELINE (MM/YYYY)';

  sheet.mergeCells('M7:N7');
  sheet.getCell('M7').value = 'FUNDING DETAILS';

  sheet.mergeCells('O7:O8');
  sheet.getCell('O7').value = 'PROCUREMENT STRATEGIES AND TOOLS';

  sheet.mergeCells('P7:P8');
  sheet.getCell('P7').value = 'ATTACHED SUPPORTING DOCUMENTS';

  sheet.mergeCells('Q7:Q8');
  sheet.getCell('Q7').value = 'GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT';

  sheet.mergeCells('R7:R8');
  sheet.getCell('R7').value = 'REMARKS';
  sheet.getRow(7).height = 24;

  // Subheaders (Row 8)
  const subHeaders = [
    'General Description and Objective of the Project to be Procured',
    'Object Code',
    'Type of the Project to be Procured',
    'Quantity and Size of the Project to be Procured',
    'Recommended Mode of Procurement',
    'Pre-Procurement Conference (Yes/No)',
    'Criteria for Bid Evaluation',
    'Advertisement/Posting of IB/REI',
    'Submission/Opening of Bids',
    'Notice of Award',
    'Contract Signing',
    'Expected Delivery/ Implementation Period',
    'Source of Funds',
    'Estimated Budget / Authorized Budgetary Allocation (PhP)'
  ];
  for (let i = 0; i < subHeaders.length; i++) {
    sheet.getRow(8).getCell(i + 1).value = subHeaders[i];
  }
  sheet.getRow(8).height = 46;

  // Column numbers (Row 9)
  for (let c = 1; c <= 18; c++) {
    sheet.getRow(9).getCell(c).value = `Column ${c}`;
  }
  sheet.getRow(9).height = 18;

  // Blank Sample Rows (Rows 10 to 14)
  for (let r = 10; r <= 14; r++) {
    sheet.getRow(r).height = 32;
  }

  // Object Code validation (digits)
  for (let ov = 10; ov <= 14; ov++) {
    sheet.getCell(`B${ov}`).dataValidation = {
      type: 'whole',
      operator: 'between',
      allowBlank: true,
      showErrorMessage: true,
      formulae: [0, 9999999999],
      errorTitle: 'Object Code',
      error: 'Object Code must be numbers only.'
    };
  }

  // Dropdown on General Requirements
  for (let dv = 10; dv <= 14; dv++) {
    sheet.getCell(`Q${dv}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${GENERAL_REQUIREMENT_OPTIONS.join(',')}"`]
    };
  }

  // Total Budget Row (Row 15)
  sheet.mergeCells('A15:M15');
  const totLabel = sheet.getCell('A15');
  totLabel.value = 'TOTAL BUDGET:';
  totLabel.font = { name: 'Arial', size: 9.5, bold: true };
  totLabel.alignment = { horizontal: 'right', vertical: 'middle' };

  const totVal = sheet.getCell('N15');
  totVal.value = { formula: 'SUM(N10:N14)', result: 0 };
  totVal.font = { name: 'Arial', size: 9.5, bold: true };
  totVal.alignment = { horizontal: 'right', vertical: 'middle' };
  totVal.numFmt = '"₱ "#,##0.00';
  sheet.getRow(15).height = 24;

  const thinBorder = {
    top: { style: 'thin', color: { argb: 'FF000000' } },
    left: { style: 'thin', color: { argb: 'FF000000' } },
    bottom: { style: 'thin', color: { argb: 'FF000000' } },
    right: { style: 'thin', color: { argb: 'FF000000' } }
  };

  for (let rowIdx = 7; rowIdx <= 15; rowIdx++) {
    const rowObj = sheet.getRow(rowIdx);
    for (let colIdx = 1; colIdx <= 18; colIdx++) {
      const cell = rowObj.getCell(colIdx);
      cell.border = thinBorder;
      if (rowIdx <= 9) {
        cell.font = { name: 'Arial', size: 8.5, bold: true, color: { argb: 'FF000000' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      } else if (rowIdx >= 10 && rowIdx <= 14) {
        cell.font = { name: 'Arial', size: 9, color: { argb: 'FF000000' } };
        const align = colIdx === 14 ? 'right' : colIdx >= 3 && colIdx <= 12 ? 'center' : 'left';
        cell.alignment = { horizontal: align, vertical: 'middle', wrapText: true };
        if (colIdx === 14) cell.numFmt = '"₱ "#,##0.00';
        if (colIdx === 2) cell.numFmt = '0';
        if (colIdx >= 8 && colIdx <= 12) cell.numFmt = 'yyyy-mm-dd';
      }
    }
  }

  // Signatures
  sheet.getRow(18).height = 20;
  sheet.getCell('A18').value = 'Prepared by / Submitted by:';
  sheet.getCell('A18').font = { name: 'Arial', size: 9.5, bold: true };

  sheet.getCell('I18').value = 'Endorsed by:';
  sheet.getCell('I18').font = { name: 'Arial', size: 9.5, bold: true };

  sheet.getCell('O18').value = 'Certified Funds Available:';
  sheet.getCell('O18').font = { name: 'Arial', size: 9.5, bold: true };

  const sigUnderline = { top: { style: 'medium', color: { argb: 'FF000000' } } };

  function makeSigBlock(startCol, endCol, name, roleTitle, officeName, withDate) {
    const startLetter = String.fromCharCode(64 + startCol);
    const endLetter = String.fromCharCode(64 + endCol);

    sheet.mergeCells(`${startLetter}21:${endLetter}21`);
    const nCell = sheet.getCell(`${startLetter}21`);
    nCell.value = name;
    nCell.font = { name: 'Arial', size: 9.5, bold: true };
    nCell.alignment = { horizontal: 'center', vertical: 'middle' };

    for (let c = startCol; c <= endCol; c++) {
      sheet.getRow(21).getCell(c).border = sigUnderline;
    }

    sheet.mergeCells(`${startLetter}22:${endLetter}22`);
    const tCell = sheet.getCell(`${startLetter}22`);
    tCell.value = roleTitle;
    tCell.font = { name: 'Arial', size: 8.5 };
    tCell.alignment = { horizontal: 'center', vertical: 'middle' };

    sheet.mergeCells(`${startLetter}23:${endLetter}23`);
    const oCell = sheet.getCell(`${startLetter}23`);
    oCell.value = officeName;
    oCell.font = { name: 'Arial', size: 8.5 };
    oCell.alignment = { horizontal: 'center', vertical: 'middle' };

    if (withDate) {
      const dCell = sheet.getCell(`${startLetter}25`);
      dCell.value = `Date: ${dateStr}`;
      dCell.font = { name: 'Arial', size: 8.5 };
      dCell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
  }

  makeSigBlock(1, 4, 'JAYMARK D. DUMIO', 'Signature over Printed Name', 'Focal, ICT Literacy Competency and Development Bureau X', true);
  makeSigBlock(9, 12, 'EUGENE C. RAPOSALA III', 'Signature over Printed Name', 'Chief, Technical Operations Division', false);
  makeSigBlock(15, 18, 'BRYAN JOHN M. SABLAS', 'Signature over Printed Name', 'Budget Officer II', false);

  // Instructions Sheet
  const help = workbook.addWorksheet('Instructions');
  help.columns = [{ width: 34 }, { width: 80 }];
  const helpRows = [
    [`How to fill in the "${TEMPLATE_SHEET}" sheet`, ''],
    ['', ''],
    ['Rows', 'One item per row in the numbered rows under the headers. Add more rows above the TOTAL BUDGET row if needed.'],
    ['Object Code', 'Numbers only (e.g. 5020301002). The PAP Code is assigned automatically; do not enter it.'],
    ['Dates', 'Dates must be formatted as YYYY-MM-DD (e.g. 2026-10-01). Advertisement <= Bid Opening <= Notice of Award <= Contract Signing < Delivery.'],
    ['Budget', 'A positive number greater than 0. The mode must match the budget bracket.'],
    ['Strategies', 'One or more allowed strategies separated by semicolon or newline.'],
    ['Re-bids', 'Enter the usual mode (e.g. Competitive Bidding). If the same project (same description, same office) already has two competitive biddings, the system switches it to Negotiated Procurement – Two Failed Biddings automatically.'],
    ['Supporting Documents', 'Leave blank. Files cannot be imported via spreadsheet; attach them to each item via Edit before submitting.'],
    ['General Requirements', `Optional. Choose one of: ${GENERAL_REQUIREMENT_OPTIONS.join(', ')} (or leave blank).`],
    ['Do Not Change', 'Do not rename header rows, the sheet name, or the signature blocks.'],
    ['', ''],
    ['Type of the Project', PROJECT_TYPES.join('\n')],
    ['Recommended Mode of Procurement', STANDARD_PROCUREMENT_MODES.join('\n')],
    ['Pre-Procurement Conference', 'Yes\nNo'],
    ['Criteria for Bid Evaluation', BID_CRITERIA_OPTIONS.join('\n')],
    ['Procurement Strategies and Tools', STRATEGY_OPTIONS.join('\n')]
  ];

  helpRows.forEach((values, i) => {
    const row = help.getRow(i + 1);
    row.getCell(1).value = values[0];
    row.getCell(2).value = values[1];
    row.getCell(1).font = { name: 'Arial', size: i === 0 ? 13 : 10, bold: true };
    row.getCell(2).font = { name: 'Arial', size: 10 };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(1).alignment = { vertical: 'top' };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = TEMPLATE_FILE;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const RECORDS_KEY = 'procurement_records';

function readRecords() {
  try {
    return JSON.parse(localStorage.getItem(RECORDS_KEY)) || [];
  } catch {
    return [];
  }
}

/**
 * Saves validated rows as line items.
 *  - targetRecordId == null -> creates a new Draft PPMP (number, fiscal year and
 *    office come from headerData / user).
 *  - targetRecordId given   -> appends to that Draft PPMP and uses ITS fiscal
 *    year, office and number for everything (headerData is ignored).
 * Throws an Error with a user-readable message when it can't import.
 * Returns { ppmp_no, fiscal_year, count, converted } where `converted` is how
 * many rows were switched to Two Failed Biddings.
 */
export function commitImportedItems({ items, headerData = {}, user, targetRecordId = null }) {
  if (!user?.canRequest) {
    throw new Error('Your account is view/approve only and cannot import items.');
  }

  const records = readRecords();
  const stamp = Date.now();

  const stamped = items.map((item, i) => ({
    ...item,
    id: stamp + i,
    expense_class: item.expense_class || 'N/A', // the form requires one; the template has no column for it
    supporting_documents: []
  }));

  let finalRecords = [...records];
  let target;           // the record the items land in
  let baseItems;        // items that were already saved in it
  let ppmpNo;
  let fiscalYear;
  let endUser;
  let mode = 'existing';   // 'existing' | 'new' | 'append' | 'new-version'
  let carried = 0;         // items carried over from the previous approved PPMP
  let carriedFrom = null;  // that PPMP's number

  if (targetRecordId != null) {
    const idx = finalRecords.findIndex(r => r.id === targetRecordId);
    if (idx === -1) throw new Error('That PPMP could not be found. It may have been deleted.');
    const existing = finalRecords[idx];
    if (getPpmpStatus(existing) !== 'Draft') {
      throw new Error('This PPMP was submitted or approved in the meantime, so items can no longer be added.');
    }
    // Everything below follows the TARGET PPMP, not the dialog's defaults.
    fiscalYear = String(existing.fiscal_year);
    endUser = existing.end_user;
    ppmpNo = existing.ppmp_no;
    baseItems = Array.isArray(existing.items) ? existing.items : getRecordItems(existing);
    finalRecords[idx] = { ...existing, items: [...baseItems, ...stamped] };
    target = finalRecords[idx];
  } else {
    fiscalYear = String(headerData.fiscal_year || new Date().getFullYear());
    endUser = headerData.end_user || user?.office || 'DICT';
    if (isAppFinal(fiscalYear)) {
      throw new Error(`The APP for FY ${fiscalYear} is already final, so a new PPMP cannot be created under it.`);
    }

    // Same rules as the request form, based on the latest PPMP of this office + fiscal year.
    const plan = getNewRequestTarget(finalRecords, endUser, fiscalYear);
    mode = plan.mode;

    if (plan.mode === 'blocked') {
      throw new Error(newRequestBlockedMessage(plan.record, fiscalYear));
    }

    if (plan.mode === 'append') {
      // Latest PPMP is still a Draft: the rows become more entries in it.
      const idx = finalRecords.findIndex(r => r.id === plan.record.id);
      const existing = finalRecords[idx];
      ppmpNo = existing.ppmp_no;
      baseItems = Array.isArray(existing.items) ? existing.items : getRecordItems(existing);
      finalRecords[idx] = { ...existing, items: [...baseItems, ...stamped] };
      target = finalRecords[idx];
    } else {
      // No PPMP yet, or the latest one is approved: create the next PPMP. An approved one is
      // carried over in full, followed by the imported rows.
      ppmpNo = getNextPpmpNumber(finalRecords, endUser, fiscalYear);
      baseItems = plan.mode === 'new-version' ? carryOverItems(plan.record, stamp + stamped.length) : [];
      if (plan.mode === 'new-version') {
        carried = baseItems.length;
        carriedFrom = plan.record.ppmp_no;
      }
      target = {
        id: stamp,
        creatorId: user?.id || null,
        ppmp_no: ppmpNo,
        is_indicative: headerData.is_indicative || 'Indicative',
        end_user: endUser,
        fiscal_year: fiscalYear,
        items: [...baseItems, ...stamped],
        status: 'Draft',
        currentApproverRole: null,
        remarksHistory: [],
        date: new Date().toLocaleDateString()
      };
      finalRecords.push(target);
    }
  }

  // Reference numbers, same rules as the form:
  //  - an earlier entry of the same project (same description, same office) keeps
  //    its reference number; after two earlier competitive biddings the row becomes
  //    Negotiated Procurement – Two Failed Biddings (Sec. 33);
  //  - otherwise a new <year>-<category>-<number> reference is issued.
  // Only entries that were ALREADY SAVED count as earlier attempts. Rows from this
  // same file never do — two rows with the same description are two separate
  // entries, so each keeps its own reference and its own budget in the totals.
  const lookupRecord = { id: target.id, end_user: endUser, items: baseItems };
  const failedBiddingDescriptions = [];

  stamped.forEach((it) => {
    const refInfo = findExistingReferenceInfo(it.project_description, it.project_type, lookupRecord, endUser);
    if (refInfo?.reference_no) {
      it.reference_no = refInfo.reference_no;
    } else {
      it.reference_no = claimEntryRef(finalRecords, it.project_type, fiscalYear);
    }
    if (refInfo && refInfo.competitiveCount >= 2) {
      it.mode = FAILED_BIDDING_MODE;
      it.bid_evaluation_criteria = NEGOTIATED_CRITERIA;
      const autoNote = 'Negotiated Procurement after Two Failed Biddings (RA 12009 Sec. 33)';
      if (!it.remarks || !it.remarks.includes('Two Failed Biddings')) {
        it.remarks = it.remarks ? `${it.remarks} [${autoNote}]` : autoNote;
      }
      failedBiddingDescriptions.push(it.project_description);
    }
  });

  // Same follow-up the form does on save: mark the earlier attempts [1st Failure] / [2nd Failure].
  failedBiddingDescriptions.forEach((desc) => {
    finalRecords = tagFailedAttempts(finalRecords, desc, endUser);
  });

  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(finalRecords));
  } catch (err) {
    console.error('Bulk import: could not save', err);
    throw new Error('The items could not be saved (browser storage is full).');
  }

  return {
    ppmp_no: ppmpNo,
    fiscal_year: fiscalYear,
    count: stamped.length,
    converted: failedBiddingDescriptions.length,
    mode,
    carried,
    carried_from: carriedFrom
  };
}