// PPMP Excel export (.xlsx) built with ExcelJS.
//   exportPPMP_Excel(record, notify?)      -> one PPMP as its own workbook
//   exportEntriesExcel(records, notify?)   -> one sheet per PPMP in a master workbook
// `notify` is an optional callback (e.g. your toast setter) for progress messages.

import ExcelJS from 'exceljs';
import { getRecordItems, parseBudgetNumber, calculateDeduplicatedBudget } from './procurementRules.js';

const BLACK = { argb: 'FF000000' };
const THIN = { style: 'thin', color: BLACK };
const THIN_BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const SIG_UNDERLINE = { top: { style: 'medium', color: BLACK } };
const PESO_FORMAT = '"P "#,##0.00';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// "2026-03-05" -> real Excel date (so the cell sorts and formats as a date)
function isoToDate(val) {
  if (!val) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(val).trim());
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

const font = (size, bold = false) => ({ name: 'Arial', size, bold, color: BLACK });
const colLetter = (n) => String.fromCharCode(64 + n); // A..Z is enough for 17 columns

// Excel sheet names: max 31 chars, no \ / ? * [ ] :, and they must be unique in the workbook.
function uniqueSheetName(workbook, base) {
  const clean = String(base).replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
  let name = clean;
  let n = 2;
  while (workbook.getWorksheet(name)) {
    const suffix = ` (${n++})`;
    name = clean.slice(0, 31 - suffix.length) + suffix;
  }
  return name;
}

function buildPpmpWorksheet(workbook, record, sheetTitle) {
  const items = getRecordItems(record);
  const ppmpNo = record.ppmp_no || 'N/A';
  const isFinal = record.is_indicative === 'Final';
  const dateStr = new Date().toLocaleDateString('en-US');

  const sheet = workbook.addWorksheet(
    uniqueSheetName(workbook, sheetTitle || `PPMP No. ${ppmpNo}`),
    { views: [{ showGridLines: true }] }
  );

  // 17 columns, A to Q
  sheet.columns = [
    { width: 36 }, { width: 22 }, { width: 24 }, { width: 28 }, { width: 20 },
    { width: 28 }, { width: 22 }, { width: 22 }, { width: 18 }, { width: 18 },
    { width: 22 }, { width: 20 }, { width: 24 }, { width: 32 }, { width: 26 },
    { width: 32 }, { width: 22 }
  ];

  // Title block (rows 1-6)
  sheet.mergeCells('A1:Q1');
  const title = sheet.getCell('A1');
  title.value = `PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. ${ppmpNo}`;
  title.font = font(14, true);
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 28;

  sheet.mergeCells('A2:Q2');
  const check = sheet.getCell('A2');
  check.value = isFinal ? '[ ] INDICATIVE     [X] FINAL' : '[X] INDICATIVE     [ ] FINAL';
  check.font = font(10, true);
  check.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(2).height = 20;

  sheet.getRow(3).height = 8;

  sheet.getCell('A4').value = `Fiscal Year : ${record.fiscal_year || new Date().getFullYear()}`;
  sheet.getCell('A4').font = font(11, true);
  sheet.getRow(4).height = 20;

  sheet.getCell('A5').value = `End-User or Implementing Unit: ${record.end_user || 'N/A'}`;
  sheet.getCell('A5').font = font(11, true);
  sheet.getRow(5).height = 20;

  sheet.getRow(6).height = 10;

  // Group headers (row 7)
  const groups = [
    ['A7:F7', 'A7', 'PROCUREMENT PROJECT DETAILS'],
    ['G7:K7', 'G7', 'PROJECTED TIMELINE (MM/YYYY)'],
    ['L7:M7', 'L7', 'FUNDING DETAILS'],
    ['N7:N8', 'N7', 'PROCUREMENT STRATEGIES AND TOOLS'],
    ['O7:O8', 'O7', 'ATTACHED SUPPORTING DOCUMENTS'],
    ['P7:P8', 'P7', 'GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT'],
    ['Q7:Q8', 'Q7', 'REMARKS']
  ];
  groups.forEach(([range, anchor, text]) => {
    sheet.mergeCells(range);
    sheet.getCell(anchor).value = text;
  });
  sheet.getRow(7).height = 24;

  // Sub-headers (row 8) and column numbers (row 9)
  const subHeaders = [
    'General Description and Objective of the Project to be Procured',
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
  subHeaders.forEach((h, i) => { sheet.getRow(8).getCell(i + 1).value = h; });
  sheet.getRow(8).height = 46;

  for (let c = 1; c <= 17; c++) sheet.getRow(9).getCell(c).value = `Column ${c}`;
  sheet.getRow(9).height = 18;

  for (let r = 7; r <= 9; r++) {
    for (let c = 1; c <= 17; c++) {
      const cell = sheet.getRow(r).getCell(c);
      cell.border = THIN_BORDER;
      cell.font = font(8.5, true);
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }
  }

  // Data rows (row 10 onwards)
  const firstDataRow = 10;
  items.forEach((it, idx) => {
    const row = sheet.getRow(firstDataRow + idx);
    row.values = [
      it.project_description || '',
      it.project_type || '',
      it.quantity_size || '',
      it.mode || '',
      it.pre_procurement || '',
      it.bid_evaluation_criteria || 'N/A',
      isoToDate(it.start_date),
      isoToDate(it.bid_opening_date),
      isoToDate(it.notice_of_award_date),
      isoToDate(it.end_date),
      isoToDate(it.delivery_period),
      it.fund_source || '',
      parseBudgetNumber(it.budget),
      Array.isArray(it.strategies) ? it.strategies.join('\n') : (it.strategies || ''),
      Array.isArray(it.supporting_documents)
        ? it.supporting_documents.map((d) => d.name || 'Document').join('\n')
        : '',
      it.general_requirements || '',
      it.remarks || ''
    ];
    row.height = 34;

    for (let c = 1; c <= 17; c++) {
      const cell = row.getCell(c);
      cell.border = THIN_BORDER;
      cell.font = font(9);
      if (c >= 7 && c <= 11) {
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.numFmt = 'yyyy-mm-dd';
      } else if (c === 13) {
        cell.alignment = { horizontal: 'right', vertical: 'middle' };
        cell.numFmt = PESO_FORMAT;
      } else if ((c >= 2 && c <= 6) || c === 12) {
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      } else {
        cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      }
    }
  });

  // Total row. Written as a plain value (not SUM()) so re-bids that share a
  // reference number are counted once, exactly like the PDF.
  const totalRow = firstDataRow + items.length;
  sheet.mergeCells(`A${totalRow}:L${totalRow}`);
  const totLabel = sheet.getCell(`A${totalRow}`);
  totLabel.value = 'TOTAL BUDGET:';
  totLabel.font = font(9.5, true);
  totLabel.alignment = { horizontal: 'right', vertical: 'middle' };

  const totValue = sheet.getCell(`M${totalRow}`);
  totValue.value = calculateDeduplicatedBudget(items);
  totValue.font = font(9.5, true);
  totValue.alignment = { horizontal: 'right', vertical: 'middle' };
  totValue.numFmt = PESO_FORMAT;

  sheet.getRow(totalRow).height = 24;
  for (let c = 1; c <= 17; c++) sheet.getRow(totalRow).getCell(c).border = THIN_BORDER;

  // Signatories: Prepared by (A-D), Endorsed by (G-J), Certified Funds (M-P)
  const sigRow = totalRow + 3;
  sheet.getRow(sigRow).height = 20;
  [['A', 'Prepared by / Submitted by:'], ['G', 'Endorsed by:'], ['M', 'Certified Funds Available:']]
    .forEach(([col, label]) => {
      const cell = sheet.getCell(`${col}${sigRow}`);
      cell.value = label;
      cell.font = font(9.5, true);
    });

  const signBlock = (startCol, endCol, name, caption, office, showDate) => {
    const a = colLetter(startCol);
    const b = colLetter(endCol);
    const nameRow = sigRow + 3;

    sheet.mergeCells(`${a}${nameRow}:${b}${nameRow}`);
    const nameCell = sheet.getCell(`${a}${nameRow}`);
    nameCell.value = name;
    nameCell.font = font(9.5, true);
    nameCell.alignment = { horizontal: 'center', vertical: 'middle' };
    for (let c = startCol; c <= endCol; c++) sheet.getRow(nameRow).getCell(c).border = SIG_UNDERLINE;

    [[nameRow + 1, caption], [nameRow + 2, office]].forEach(([r, text]) => {
      sheet.mergeCells(`${a}${r}:${b}${r}`);
      const cell = sheet.getCell(`${a}${r}`);
      cell.value = text;
      cell.font = font(8.5);
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    if (showDate) {
      const dateCell = sheet.getCell(`${a}${nameRow + 4}`);
      dateCell.value = `Date: ${dateStr}`;
      dateCell.font = font(8.5);
      dateCell.alignment = { horizontal: 'center', vertical: 'middle' };
    }
  };

  signBlock(1, 4, 'JAYMARK D. DUMIO', 'Signature over Printed Name', 'Focal, ICT Literacy Competency and Development Bureau X', true);
  signBlock(7, 10, 'EUGENE C. RAPOSALA III', 'Signature over Printed Name', 'Chief, Technical Operations Division', false);
  signBlock(13, 16, 'BRYAN JOHN M. SABLAS', 'Signature over Printed Name', 'Budget Officer II', false);
}

async function downloadWorkbook(workbook, fileName) {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: XLSX_MIME });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function newWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DICT Procurement System';
  workbook.created = new Date();
  return workbook;
}

export async function exportPPMP_Excel(record, notify = () => {}) {
  if (!record) {
    notify('PPMP record could not be found to export.');
    return;
  }
  notify('Generating styled PPMP Excel file...');

  const workbook = newWorkbook();
  buildPpmpWorksheet(workbook, record, `PPMP No. ${record.ppmp_no || '1'}`);

  const fileName = `PPMP_${record.ppmp_no || '1'}_${String(record.end_user || 'Office').replace(/[^\w-]+/g, '_')}.xlsx`;
  await downloadWorkbook(workbook, fileName);
  notify(`Exported ${fileName} successfully.`);
}

export async function exportEntriesExcel(records, notify = () => {}) {
  if (!records || records.length === 0) {
    notify('Nothing to export. No PPMP entries match the current filters.');
    return;
  }
  notify('Generating styled PPMP Excel export...');

  const workbook = newWorkbook();
  records.forEach((rec, index) => {
    buildPpmpWorksheet(workbook, rec, `PPMP No. ${rec.ppmp_no || index + 1}`);
  });

  await downloadWorkbook(workbook, `PPMP_Entries_${new Date().toISOString().slice(0, 10)}.xlsx`);
  notify(`Exported ${records.length} ${records.length === 1 ? 'PPMP' : 'PPMPs'} to Excel.`);
}