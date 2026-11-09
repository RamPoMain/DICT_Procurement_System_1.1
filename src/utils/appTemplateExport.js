// APP Excel exports for the Suppliers account. Put in src/utils/appTemplateExport.js.
//
//   exportAppTemplateExcel(year, { session, notify })  -> PhilGEPS APP template (.xlsx)
//   exportAppExcel(year, { session, notify })          -> Excel version of the APP PDF (.xlsx)
//
// Both use the latest approved PPMP of each office for the year, exactly like the
// APP PDF, and both route items into General / Miscellaneous / CSE with the same
// rule as the PDF (appSectionOf in pdfGenerator.js).

import ExcelJS from 'exceljs';
import {
  getAppRecord,
  getLatestApprovedPpmpPerOffice,
  getRecordItems,
  calculateDeduplicatedBudget
} from './procurementRules.js';
import { appSectionOf, APP_SECTION_TITLES } from './pdfGenerator.js';

// Accounts that may export (session.role). Add 'ARD', 'RD' to share it.
export const EXPORT_ROLES = ['SUP'];

const AGENCY_NAME = 'Department of Information and Communications Technology';
const BANNER_URL = '/images/header-banner.png';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------
const THIN = { style: 'thin', color: { argb: 'FF000000' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const WHITE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
const GREY = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
const PESO_FMT = '#,##0.00;(#,##0.00);"-"';

const parseBudget = (raw) => parseFloat(String(raw ?? '').replace(/[^0-9.]/g, '')) || 0;
const yesNo = (v) => (String(v ?? '').trim().toLowerCase() === 'yes' ? 'Yes' : 'No');
const dateOf = (ts) => (ts ? new Date(Number(ts)).toLocaleDateString() : '');

// The PPMP has no MOOE / CO field yet, so the class is derived here.
// Infrastructure = Capital Outlay (CO); Goods and Consulting Services = MOOE.
// An explicit item.expense_class ('MOOE' | 'CO') wins once the form captures it.
function expenseClass(item) {
  const explicit = String(item.expense_class || '').trim().toUpperCase();
  if (explicit === 'MOOE' || explicit === 'CO') return explicit;
  return String(item.project_type || '').trim() === 'Infrastructure' ? 'CO' : 'MOOE';
}

// Accepts YYYY-MM-DD, YYYY-MM and MM/YYYY. Anything else is kept as typed so no
// data is ever dropped from the export.
function dateCell(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null };
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { value: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), fmt: 'dd-mmm-yyyy' };
  m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return { value: new Date(Date.UTC(+m[1], +m[2] - 1, 1)), fmt: 'mmm yyyy' };
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return { value: new Date(Date.UTC(+m[2], +m[1] - 1, 1)), fmt: 'mmm yyyy' };
  return { value: s };
}

function headerCell(ws, ref, text, size) {
  const c = ws.getCell(ref);
  c.value = text;
  c.font = { name: 'Arial', size: size || 9, bold: true };
  c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  c.fill = WHITE;
  c.border = BORDER;
}

function mergedHeader(ws, from, to, text, size) {
  ws.mergeCells(`${from}:${to}`);
  headerCell(ws, from, text, size);
  // merged cells need the border on every cell or Excel draws gaps
  const [c1, r1] = [from.replace(/\d+/g, ''), +from.replace(/\D+/g, '')];
  const [c2, r2] = [to.replace(/\d+/g, ''), +to.replace(/\D+/g, '')];
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1.charCodeAt(0); c <= c2.charCodeAt(0); c += 1) {
      ws.getCell(`${String.fromCharCode(c)}${r}`).border = BORDER;
    }
  }
}

function readRecords() {
  try {
    return JSON.parse(localStorage.getItem('procurement_records')) || [];
  } catch {
    return [];
  }
}

// Items of the latest approved PPMP per office, each tagged with its end-user.
function loadAppData(year) {
  const approved = readRecords().filter((r) => r.status === 'Completed');
  const picked = getLatestApprovedPpmpPerOffice(approved, year);
  const items = [];
  const sources = [];
  picked.forEach((record) => {
    sources.push(`${record.end_user || 'N/A'} - PPMP No. ${record.ppmp_no || 'N/A'}`);
    getRecordItems(record).forEach((it) => items.push({ ...it, end_user: record.end_user || 'N/A' }));
  });
  const appRecord = getAppRecord(year) || {};
  return { items, sources, appRecord, isFinal: appRecord.status === 'Completed' };
}

async function downloadWorkbook(wb, fileName) {
  const buffer = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buffer], { type: XLSX_MIME }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Shared checks for both exports. Returns { year, data } or null (after telling the user why).
function prepare(targetYear, session, notify) {
  if (!session || !EXPORT_ROLES.includes(session.role)) {
    notify('Access denied: you do not have permission to export the APP.');
    return null;
  }
  const year = String(targetYear || new Date().getFullYear()).trim();
  const data = loadAppData(year);
  if (data.items.length === 0) {
    notify(`No fully approved PPMPs for FY ${year} to put in the APP.`);
    return null;
  }
  return { year, data };
}

// ---------------------------------------------------------------
// 1. PhilGEPS APP template  (columns A-N)
//    Code (PAP) | Procurement Project | PMO/End-User | Early Procurement Activity? |
//    Mode | Ads/Posting | Bid Opening | Notice of Award | Contract Signing |
//    Source of Funds | Total | MOOE | CO | Remarks
// ---------------------------------------------------------------
const PG_FIRST_ROW = 5;
const PG_COLS = 14;

function philgepsRow(it) {
  const amount = parseBudget(it.budget);
  const cls = expenseClass(it);
  return {
    code: it.reference_no || '',
    title: it.project_description || '',
    endUser: it.end_user || '',
    early: yesNo(it.pre_procurement),
    mode: it.mode || '',
    dates: [it.start_date, it.bid_opening_date, it.notice_of_award_date, it.end_date],
    fund: it.fund_source || '',
    amount,
    mooe: cls === 'MOOE' ? amount : 0,
    co: cls === 'CO' ? amount : 0,
    remarks: it.remarks || ''
  };
}

function addPhilgepsSheet(wb, sheetName, items, opts) {
  const ws = wb.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  [18, 40, 24, 14, 34, 14, 14, 14, 14, 18, 16, 16, 16, 36].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  ws.mergeCells('A1:N1');
  ws.getCell('A1').value = `${AGENCY_NAME} Annual Procurement Plan for FY ${opts.year}`;
  ws.getCell('A1').font = { name: 'Arial', size: 14, bold: true };
  ws.getCell('A1').alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(1).height = 30;

  ws.mergeCells('A2:N2');
  ws.getCell('A2').value = opts.statusNote;
  ws.getCell('A2').font = { name: 'Arial', size: 9, italic: true };
  ws.getCell('A2').alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(2).height = 18;

  // Two-row header, same layout and merges as the PhilGEPS template
  [['A', 'Code (PAP)'], ['B', 'Procurement Project'], ['C', 'PMO/End-User'],
    ['D', 'Is this an Early Procurement Activity? (Yes/No)'], ['E', 'Mode of Procurement'],
    ['J', 'Source of Funds'], ['N', 'Remarks (brief description of Project)']]
    .forEach(([col, text]) => mergedHeader(ws, `${col}3`, `${col}4`, text));
  mergedHeader(ws, 'F3', 'I3', 'Schedule for Each Procurement Activity');
  mergedHeader(ws, 'K3', 'M3', 'Estimated Budget (PhP)');
  [['F', 'Advertisement/Posting of IB/REI'], ['G', 'Submission/Opening of Bids'],
    ['H', 'Notice of Award'], ['I', 'Contract Signing'],
    ['K', 'Total'], ['L', 'MOOE'], ['M', 'CO']]
    .forEach(([col, text]) => headerCell(ws, `${col}4`, text, 8));
  ws.getRow(3).height = 24;
  ws.getRow(4).height = 36;

  const rows = items.map(philgepsRow);
  rows.forEach((r, i) => {
    const n = PG_FIRST_ROW + i;
    const row = ws.getRow(n);
    row.getCell(1).value = r.code || null;
    row.getCell(2).value = r.title || null;
    row.getCell(3).value = r.endUser || null;
    row.getCell(4).value = r.early;
    row.getCell(5).value = r.mode || null;
    r.dates.forEach((raw, d) => {
      const { value, fmt } = dateCell(raw);
      const cell = row.getCell(6 + d);
      cell.value = value;
      if (fmt) cell.numFmt = fmt;
    });
    row.getCell(10).value = r.fund || null;
    row.getCell(11).value = { formula: `L${n}+M${n}`, result: r.amount }; // Total = MOOE + CO
    row.getCell(12).value = r.mooe;
    row.getCell(13).value = r.co;
    row.getCell(14).value = r.remarks || null;

    for (let c = 1; c <= PG_COLS; c += 1) {
      const cell = row.getCell(c);
      cell.font = { name: 'Arial', size: 9 };
      cell.border = BORDER;
      const centered = c === 4 || (c >= 6 && c <= 9);
      cell.alignment = {
        vertical: 'middle',
        wrapText: true,
        horizontal: centered ? 'center' : c >= 11 && c <= 13 ? 'right' : 'left'
      };
      if (c >= 11 && c <= 13) cell.numFmt = PESO_FMT;
    }
    row.getCell(4).dataValidation = { type: 'list', allowBlank: false, formulae: ['"Yes,No"'] };
  });

  const last = PG_FIRST_ROW + rows.length - 1;
  const tot = last + 1;
  ws.mergeCells(`A${tot}:J${tot}`);
  ws.getCell(`A${tot}`).value = 'TOTAL';
  [['K', 'amount'], ['L', 'mooe'], ['M', 'co']].forEach(([col, key]) => {
    ws.getCell(`${col}${tot}`).value = {
      formula: `SUM(${col}${PG_FIRST_ROW}:${col}${last})`,
      result: rows.reduce((s, r) => s + r[key], 0)
    };
    ws.getCell(`${col}${tot}`).numFmt = PESO_FMT;
  });
  for (let c = 1; c <= PG_COLS; c += 1) {
    const cell = ws.getRow(tot).getCell(c);
    cell.font = { name: 'Arial', size: 9, bold: true };
    cell.border = BORDER;
    cell.fill = WHITE;
    cell.alignment = { horizontal: 'right', vertical: 'middle' };
  }

  // Template behaviour: blank required cells show orange
  const orange = { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC000' } };
  ['A', 'F'].forEach((startCol) => {
    const endCol = startCol === 'A' ? 'E' : 'J';
    ws.addConditionalFormatting({
      ref: `${startCol}${PG_FIRST_ROW}:${endCol}${last}`,
      rules: [{ type: 'expression', formulae: [`LEN(TRIM(${startCol}${PG_FIRST_ROW}))=0`], style: { fill: orange } }]
    });
  });

  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

export function buildPhilgepsWorkbook(ExcelJSLib, items, opts) {
  const wb = new ExcelJSLib.Workbook();
  wb.creator = 'DICT Procurement';
  wb.created = new Date();

  const nonCse = items.filter((it) => appSectionOf(it) !== 'cse');
  const cse = items.filter((it) => appSectionOf(it) === 'cse');
  [['APP Non-CSE', nonCse], ['APP CSE', cse]]
    .filter(([, list]) => list.length > 0)
    .forEach(([name, list]) => addPhilgepsSheet(wb, name, list, opts));

  const ns = wb.addWorksheet('Export Notes');
  ns.getColumn(1).width = 28;
  ns.getColumn(2).width = 90;
  [
    ['PhilGEPS APP Template Export', ''],
    ['Fiscal year', opts.year],
    ['APP status', opts.appStatus],
    ['Exported by', opts.exportedBy],
    ['Exported on', new Date().toLocaleString('en-PH')],
    ['Source PPMPs', opts.sources.join('; ')],
    ['', ''],
    ['Sheets', 'APP Non-CSE holds General Requirements and Miscellaneous items. Items routed to Common Supplies and Equipment (CSE) are on the APP CSE sheet, same columns.'],
    ['Code (PAP)', "The entry's reference number from the system (e.g. GDS-0001)."],
    ['Early Procurement Activity', 'Taken from the PPMP field the APP PDF already uses for this column. Defaults to No.'],
    ['MOOE / CO', 'The PPMP has no MOOE/CO field. Infrastructure entries are placed under CO; Goods and Consulting Services under MOOE. Each row fills one of the two, and Total = MOOE + CO as in the template. Review before uploading.'],
    ['Schedule', 'Month-only entries show as MMM YYYY; entries with a day show as DD-MMM-YYYY.'],
    ['Procurement Monitoring Report', 'Not part of the APP and not exported.']
  ].forEach((n, i) => {
    const row = ns.getRow(i + 1);
    row.values = n;
    row.font = { name: 'Arial', size: 10, bold: i === 0 || n[0] !== '' };
    row.getCell(2).font = { name: 'Arial', size: 10 };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(1).alignment = { vertical: 'top' };
  });
  ns.getRow(1).font = { name: 'Arial', size: 12, bold: true };
  return wb;
}

export async function exportAppTemplateExcel(targetYear, { session = null, notify = (m) => alert(m) } = {}) {
  const ready = prepare(targetYear, session, notify);
  if (!ready) return;
  const { year, data } = ready;

  const wb = buildPhilgepsWorkbook(ExcelJS, data.items, {
    year,
    appStatus: data.isFinal ? 'Final (approved)' : 'Draft: the APP for this year has not been approved yet',
    statusNote: data.isFinal ? 'Final APP (approved)' : 'DRAFT: this APP has not been approved yet',
    exportedBy: `${session.roleName} (${session.email})`,
    sources: data.sources
  });

  try {
    await downloadWorkbook(wb, `APP_FY${year}_PhilGEPS_${data.isFinal ? 'Final' : 'Draft'}.xlsx`);
    notify(`Exported the PhilGEPS APP template for FY ${year} (${data.items.length} entries).`);
  } catch (err) {
    console.error('PhilGEPS APP export failed:', err);
    notify('The PhilGEPS APP template could not be exported.');
  }
}

// ---------------------------------------------------------------
// 2. Excel version of the APP PDF (GPPB layout, sections, signatories)
// ---------------------------------------------------------------
const LAYOUT_COLS = 14;
const BUDGET_COL = 12; // "Estimated Budget / Approved Budget for the Contract"

const layoutRow = (it) => [
  it.quantity_size ? `${it.project_description} (${it.quantity_size})` : (it.project_description || 'N/A'),
  it.end_user || 'N/A',
  it.project_type || 'N/A',
  it.mode || 'N/A',
  it.pre_procurement || 'No',
  it.bid_evaluation_criteria || 'N/A',
  it.start_date || '',
  it.bid_opening_date || '',
  it.notice_of_award_date || '',
  it.end_date || '',
  it.fund_source || 'N/A',
  parseBudget(it.budget),
  Array.isArray(it.strategies) ? it.strategies.join('\n') : (it.strategies || ''),
  it.remarks || ''
];

// Drops the header banner on top of the sheet at its real aspect ratio.
// Returns the row-1 height in points, or 0 when the image could not be loaded.
async function addBanner(wb, ws) {
  try {
    const res = await fetch(BANNER_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1100 / bitmap.width, 80 / bitmap.height, 1);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    const id = wb.addImage({ buffer: await blob.arrayBuffer(), extension: 'png' });
    ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width, height } });
    return height * 0.75 + 6;
  } catch (e) {
    console.warn('Banner image could not be loaded:', e);
    return 0;
  }
}

function addSignatory(ws, row, c1, c2, s) {
  const line = (r) => {
    if (c2 > c1) ws.mergeCells(r, c1, r, c2);
    return ws.getCell(r, c1);
  };
  const set = (r, text, font, align = 'center') => {
    const cell = line(r);
    cell.value = text;
    cell.font = { name: 'Arial', size: 8, ...font };
    cell.alignment = { horizontal: align, vertical: 'middle', wrapText: true };
  };
  set(row, s.label, {}, 'left');
  set(row + 1, '', {});
  ws.getRow(row + 1).height = 26; // room to sign
  for (let c = c1; c <= c2; c += 1) ws.getCell(row + 1, c).border = { bottom: THIN };
  set(row + 2, s.name, { bold: true });
  set(row + 3, 'Signature over Printed Name', {});
  set(row + 4, s.role, {});
  if (s.date) set(row + 5, `Date: ${s.date}`, {});
}

export async function buildAppLayoutWorkbook(ExcelJSLib, items, opts) {
  const wb = new ExcelJSLib.Workbook();
  wb.creator = 'DICT Procurement';
  wb.created = new Date();

  const ws = wb.addWorksheet(`APP FY ${opts.year}`, { views: [{ showGridLines: false }] });
  [30, 24, 22, 22, 14, 26, 12, 12, 12, 12, 16, 20, 22, 30].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const bannerHeight = await addBanner(wb, ws);
  let r = 1;
  if (bannerHeight) { ws.getRow(1).height = bannerHeight; r = 2; }

  ws.mergeCells(r, 1, r, LAYOUT_COLS);
  ws.getCell(r, 1).value = `ANNUAL PROCUREMENT PLAN FOR FY ${opts.year}`;
  ws.getCell(r, 1).font = { name: 'Arial', size: 13, bold: true };
  ws.getCell(r, 1).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(r).height = 24;
  r += 1;

  // Indicative while in review; Final once the RD has approved (same rule as the PDF)
  ws.mergeCells(r, 1, r, LAYOUT_COLS);
  ws.getCell(r, 1).value = opts.isFinal ? '☐ INDICATIVE        ☒ FINAL' : '☒ INDICATIVE        ☐ FINAL';
  ws.getCell(r, 1).font = { name: 'Arial', size: 10, bold: true };
  ws.getCell(r, 1).alignment = { horizontal: 'center', vertical: 'middle' };
  r += 2;

  // Two-row header, same groups as the PDF
  const head1 = r;
  const head2 = r + 1;
  const group = (c1, c2, text, rowSpan) => {
    ws.mergeCells(head1, c1, rowSpan ? head2 : head1, c2);
    for (let rr = head1; rr <= (rowSpan ? head2 : head1); rr += 1) {
      for (let c = c1; c <= c2; c += 1) ws.getCell(rr, c).border = BORDER;
    }
    const cell = ws.getCell(head1, c1);
    cell.value = text;
    cell.font = { name: 'Arial', size: 8, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.fill = WHITE;
  };
  group(1, 6, 'PROCUREMENT PROJECT DETAILS');
  group(7, 10, 'PROJECTED TIMELINE (MM/YYYY)');
  group(11, 12, 'FUNDING DETAILS');
  group(13, 13, 'PROCUREMENT STRATEGY OR TOOLS', true);
  group(14, 14, 'REMARKS\n(Other relevant descriptions of the procurement project, if applicable)', true);
  [
    'Project Title', 'End-User or Implementing Unit', 'General Description of the Project', 'Mode of Procurement',
    'To be covered by an Early Procurement Activity? (Yes/No)',
    'Criteria for Bid Evaluation\n(Including Sustainability and Domestic Preference)',
    'Advertisement/Posting of IB/REI', 'Submission/Opening of Bids', 'Notice of Award', 'Contract Signing',
    'Source of Fund', 'Estimated Budget / Approved Budget for the Contract (PhP)'
  ].forEach((text, i) => {
    const cell = ws.getCell(head2, i + 1);
    cell.value = text;
    cell.font = { name: 'Arial', size: 8, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.fill = WHITE;
    cell.border = BORDER;
  });
  ws.getRow(head1).height = 20;
  ws.getRow(head2).height = 58;
  ws.views = [{ state: 'frozen', ySplit: head2, showGridLines: false }];
  r = head2 + 1;

  // Sections, in the PDF's order. An empty section keeps one blank row like the PDF.
  ['general', 'misc', 'cse'].forEach((key) => {
    ws.mergeCells(r, 1, r, LAYOUT_COLS);
    const title = ws.getCell(r, 1);
    title.value = APP_SECTION_TITLES[key];
    title.font = { name: 'Arial', size: 9, bold: true };
    title.alignment = { horizontal: 'left', vertical: 'middle' };
    for (let c = 1; c <= LAYOUT_COLS; c += 1) {
      ws.getCell(r, c).fill = GREY;
      ws.getCell(r, c).border = BORDER;
    }
    r += 1;

    const list = items.filter((it) => appSectionOf(it) === key);
    const rows = list.length ? list.map(layoutRow) : [Array(LAYOUT_COLS).fill(null)];
    rows.forEach((values) => {
      const row = ws.getRow(r);
      values.forEach((v, i) => {
        const cell = row.getCell(i + 1);
        cell.value = v === '' ? null : v;
        cell.font = { name: 'Arial', size: 8 };
        cell.border = BORDER;
        cell.alignment = {
          vertical: 'top',
          wrapText: true,
          horizontal: i === BUDGET_COL - 1 ? 'right' : i >= 6 && i <= 9 ? 'center' : 'left'
        };
        if (i === BUDGET_COL - 1) cell.numFmt = PESO_FMT;
      });
      r += 1;
    });
  });
  ws.mergeCells(r, 1, r, BUDGET_COL - 1);
  ws.getCell(r, 1).value = 'TOTAL BUDGET:';
  const totalCell = ws.getCell(r, BUDGET_COL);
  // The row amounts remain visible, but repeated reference numbers count once in the APP total.
  totalCell.value = calculateDeduplicatedBudget(items);
  totalCell.numFmt = PESO_FMT;
  for (let c = 1; c <= LAYOUT_COLS; c += 1) {
    const cell = ws.getCell(r, c);
    cell.font = { name: 'Arial', size: 9, bold: true };
    cell.border = BORDER;
    cell.alignment = { horizontal: 'right', vertical: 'middle' };
  }
  r += 3;

  // Signatories: same three blocks as the PDF
  const app = opts.appRecord;
  const nameOf = (person, fallback) => (person?.name ? person.name.toUpperCase() : fallback);
  addSignatory(ws, r, 1, 3, {
    label: 'Prepared by / Submitted by:',
    name: nameOf(app.submitted_by, 'SUPPLY OFFICER II'),
    role: 'Supply Officer II / BAC Secretariat',
    date: dateOf(app.submitted_at) || new Date().toLocaleDateString()
  });
  addSignatory(ws, r, 5, 9, {
    label: 'Endorsed by:',
    name: nameOf(app.ard_approved_by, 'ASSISTANT REGIONAL DIRECTOR'),
    role: 'Assistant Regional Director / BAC Chairperson',
    date: dateOf(app.ard_approved_at)
  });
  addSignatory(ws, r, 11, 14, {
    label: 'Approved by:',
    name: nameOf(app.approved_by, 'REGIONAL DIRECTOR'),
    role: 'Regional Director / Head of the Procuring Entity',
    date: dateOf(app.approved_at)
  });

  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return wb;
}

export async function exportAppExcel(targetYear, { session = null, notify = (m) => alert(m) } = {}) {
  const ready = prepare(targetYear, session, notify);
  if (!ready) return;
  const { year, data } = ready;

  try {
    const wb = await buildAppLayoutWorkbook(ExcelJS, data.items, {
      year,
      isFinal: data.isFinal,
      appRecord: data.appRecord
    });
    await downloadWorkbook(wb, `APP_FY_${year}_DICT_${data.isFinal ? 'Final' : 'Draft'}.xlsx`);
    notify(`Exported the APP for FY ${year} as Excel (${data.items.length} entries).`);
  } catch (err) {
    console.error('APP Excel export failed:', err);
    notify('The APP could not be exported to Excel.');
  }
}

// Aliases for compatibility across components
export const exportPhilGepsAppExcel = exportAppTemplateExcel;
export const exportStandardAppExcel = exportAppExcel;