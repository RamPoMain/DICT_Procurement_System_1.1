import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  getLatestApprovedPpmpPerOffice,
  getRecordItems,
  getAppRecord,
  calculateDeduplicatedBudget
} from './procurementRules.js';

// ---------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------
const BANNER_URL = '/images/header-banner.png';
const MARGIN = 10;

const parseBudget = (raw) => parseFloat(String(raw ?? '').replace(/[^0-9.]/g, '')) || 0;
const formatMoney = (n) => n.toLocaleString('en-PH', { minimumFractionDigits: 2 });
const peso = (n) => `P ${formatMoney(n)}`;

// Works with jspdf-autotable whether it is attached to jsPDF (v3) or a function (v4/v5).
// Returns the Y position where the table ended so the signatories never overlap it.
function renderTable(doc, options) {
  let lastCursorY = null;
  const opts = {
    ...options,
    didDrawPage: (data) => { lastCursorY = data?.cursor?.y ?? lastCursorY; }
  };
  if (typeof doc.autoTable === 'function') {
    doc.autoTable(opts);
  } else if (typeof autoTable === 'function') {
    autoTable(doc, opts);
  } else if (autoTable && typeof autoTable.default === 'function') {
    autoTable.default(doc, opts);
  } else {
    throw new Error('jspdf-autotable is not available');
  }
  return doc.lastAutoTable?.finalY ?? lastCursorY;
}

// Draws the header banner at its real aspect ratio (never stretched), centred.
// Returns the drawn height in mm, or null if the image could not be loaded.
async function drawBanner(doc, pageWidth, maxImgHeight) {
  try {
    const res = await fetch(BANNER_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const imgData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const natural = await new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight });
      probe.onerror = reject;
      probe.src = imgData;
    });
    const scale = Math.min((pageWidth - MARGIN * 2) / natural.w, maxImgHeight / natural.h);
    const w = natural.w * scale;
    const h = natural.h * scale;
    doc.addImage(imgData, 'PNG', (pageWidth - w) / 2, 5, w, h);
    return h;
  } catch (e) {
    console.warn('Banner image could not be loaded:', e);
    return null;
  }
}

// Proportional column widths so every column fits the printable width.
function weightedColumnStyles(weights, usableWidth) {
  const total = weights.reduce((a, b) => a + b, 0);
  const styles = {};
  weights.forEach((w, i) => { styles[i] = { cellWidth: (usableWidth * w) / total }; });
  return styles;
}

function drawSignatory(doc, { labelX, lineFrom, lineTo, centerX, y, label, name, role, extras = [] }) {
  doc.setFont('helvetica', 'normal');
  doc.text(label, labelX, y);
  doc.line(lineFrom, y + 10, lineTo, y + 10);
  doc.setFont('helvetica', 'bold');
  doc.text(name, centerX, y + 14, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.text('Signature over Printed Name', centerX, y + 18, { align: 'center' });
  doc.text(role, centerX, y + 22, { align: 'center' });
  extras.forEach(([text, dy]) => doc.text(text, centerX, y + dy, { align: 'center' }));
}

const TABLE_BASE = {
  theme: 'grid',
  margin: { left: MARGIN, right: MARGIN },
  rowPageBreak: 'avoid', // never split one item's row across two pages
  styles: {
    cellPadding: 1.5,
    textColor: [0, 0, 0],
    lineColor: [0, 0, 0],
    lineWidth: 0.1,
    overflow: 'linebreak',
    valign: 'top'
  }
};

const centered = { halign: 'center' };
const centeredMiddle = { halign: 'center', valign: 'middle' };

// ---------------------------------------------------------------
// APP section routing, shared by the PDF and the Excel exports.
// GASS -> CSE; Direct Acquisition -> Miscellaneous;
// otherwise an explicit tag decides; everything else -> General Requirements
// ---------------------------------------------------------------
export const APP_SECTION_TITLES = {
  general: 'General Requirements',
  misc: 'Miscellaneous Items (for Direct Acquisition only) Sec 32.2 of RA No. 12009',
  cse: 'Common Supplies and Equipment (CSE)'
};

export function appSectionOf(it) {
  const eu = String(it.end_user || '').toLowerCase();
  if (eu.includes('general administration') || eu.includes('gass')) return 'cse';
  if (String(it.mode || '').trim().toLowerCase().includes('direct acquisition')) return 'misc';
  const chosen = String(it.general_requirements || '').trim();
  if (chosen === 'Common Supplies and Equipment') return 'cse';
  if (chosen === 'Miscellaneous') return 'misc';
  return 'general';
}

// ---------------------------------------------------------------
// PPMP PDF
// ---------------------------------------------------------------
async function buildPPMP_Doc(record) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const items = getRecordItems(record);
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const usableWidth = pageWidth - MARGIN * 2;

  const bannerH = await drawBanner(doc, pageWidth, 30);
  let currentY = bannerH ? 5 + bannerH + 10 : 30;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(`PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. ${record.ppmp_no || 'N/A'}`, pageWidth / 2, currentY, { align: 'center' });

  currentY += 6;
  doc.setFontSize(9);
  doc.rect(130, currentY - 3, 4, 4);
  if (record.is_indicative === 'Indicative') doc.text('X', 131, currentY);
  doc.text('INDICATIVE', 136, currentY);

  doc.rect(165, currentY - 3, 4, 4);
  if (record.is_indicative === 'Final') doc.text('X', 166, currentY);
  doc.text('FINAL', 171, currentY);

  currentY += 10;
  doc.setFontSize(10);
  doc.text(`Fiscal Year : ${record.fiscal_year || 'N/A'}`, MARGIN, currentY);
  doc.text(`End-User or Implementing Unit:  ${record.end_user || 'N/A'}`, MARGIN, currentY + 5);

  // Re-bids sharing a reference number count once in the Total Budget
  const refBudgetMap = new Map();
  let noRefTotal = 0;
  items.forEach((item) => {
    const b = parseBudget(item.budget);
    const ref = item.reference_no ? String(item.reference_no).trim() : null;
    if (ref) refBudgetMap.set(ref, b);
    else noRefTotal += b;
  });
  let totalBudget = noRefTotal;
  refBudgetMap.forEach((b) => { totalBudget += b; });

  const headers = [
    [
      { content: 'PROCUREMENT PROJECT DETAILS', colSpan: 6, styles: centered },
      { content: 'PROJECTED TIMELINE (MM/YYYY)', colSpan: 5, styles: centered },
      { content: 'FUNDING DETAILS', colSpan: 2, styles: centered },
      { content: 'PROCUREMENT STRATEGIES AND TOOLS', rowSpan: 2, styles: centeredMiddle },
      { content: 'ATTACHED SUPPORTING DOCUMENTS', rowSpan: 2, styles: centeredMiddle },
      { content: 'GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT', rowSpan: 2, styles: centeredMiddle },
      { content: 'REMARKS', rowSpan: 2, styles: centeredMiddle }
    ],
    [
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
    ],
    Array.from({ length: 17 }, (_, i) => `Column ${i + 1}`)
  ];

  const itemRows = items.map((it) => {
    const strategies = Array.isArray(it.strategies) && it.strategies.length > 0
      ? it.strategies.join('\n')
      : (it.strategies || 'None');
    const docs = Array.isArray(it.supporting_documents) && it.supporting_documents.length > 0
      ? it.supporting_documents.map((d) => d.name || 'Document').join('\n')
      : 'None';
    return [
      it.project_description || '',
      it.project_type || '',
      it.quantity_size || '',
      it.mode || '',
      it.pre_procurement || '',
      it.bid_evaluation_criteria || 'N/A',
      it.start_date || '',
      it.bid_opening_date || '',
      it.notice_of_award_date || '',
      it.end_date || '',
      it.delivery_period || '',
      it.fund_source || '',
      peso(parseBudget(it.budget)),
      strategies,
      docs,
      it.general_requirements || '',
      it.remarks || ''
    ];
  });

  const body = [
    ...itemRows,
    [
      { content: 'TOTAL BUDGET:', colSpan: 12, styles: { halign: 'right', fontStyle: 'bold' } },
      { content: peso(totalBudget), styles: { fontStyle: 'bold' } },
      '', '', '', ''
    ]
  ];

  const columnStyles = weightedColumnStyles(
    [9.5, 7, 7.5, 7.5, 5.5, 7.5, 6, 6, 6, 6, 7, 6.5, 10, 11.5, 8.5, 8, 6.5],
    usableWidth
  );
  columnStyles[12].halign = 'right'; // money lines up on the right

  const tableEndY = renderTable(doc, {
    ...TABLE_BASE,
    startY: currentY + 10,
    head: headers,
    body,
    tableWidth: usableWidth,
    styles: { ...TABLE_BASE.styles, fontSize: 6 },
    headStyles: { fillColor: [255, 255, 255], fontStyle: 'bold', fontSize: 5.5, halign: 'center', valign: 'middle', cellPadding: 1.5 },
    columnStyles
  });

  // Signatories (two rows: prepared/endorsed/certified, then a second "Endorsed by")
  let finalY = (tableEndY ?? currentY + 60) + 15;
  if (finalY + 70 > pageHeight) {
    doc.addPage();
    finalY = 20;
  }
  doc.setFontSize(7);

  const approved = record.status === 'Completed' && record.approved_by;
  const approvedOn = approved && record.approved_at
    ? ' on ' + new Date(Number(record.approved_at)).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
    : '';

  drawSignatory(doc, {
    labelX: MARGIN, lineFrom: MARGIN, lineTo: MARGIN + 60, centerX: MARGIN + 30, y: finalY,
    label: 'Prepared by / Submitted by:',
    name: 'JAYMARK D. DUMIO',
    role: 'Focal, ICT Literacy Competency and Development Bureau X',
    extras: [['Date: ' + new Date().toLocaleDateString(), 30]]
  });
  drawSignatory(doc, {
    labelX: pageWidth / 2 - 30, lineFrom: pageWidth / 2 - 35, lineTo: pageWidth / 2 + 25, centerX: pageWidth / 2 - 5, y: finalY,
    label: 'Endorsed by:',
    name: 'EUGENE C. RAPOSALA III',
    role: 'Chief, Technical Operations Division'
  });
  drawSignatory(doc, {
    labelX: pageWidth - 70, lineFrom: pageWidth - 70, lineTo: pageWidth - MARGIN, centerX: pageWidth - 35, y: finalY,
    label: 'Certified Funds Available:',
    name: 'BRYAN JOHN M. SABLAS',
    role: 'Budget Officer II',
    extras: approved ? [['Approved in system by ' + record.approved_by.name + approvedOn, 26]] : []
  });
  drawSignatory(doc, {
    labelX: MARGIN, lineFrom: MARGIN, lineTo: MARGIN + 60, centerX: MARGIN + 30, y: finalY + 45,
    label: 'Endorsed by:',
    name: 'EUGENE C. RAPOSALA III',
    role: 'Chief, Technical Operations Division'
  });

  return doc;
}

export async function buildPPMP_PDF_Blob(record) {
  return (await buildPPMP_Doc(record)).output('blob');
}

export async function generatePPMP_PDF(record) {
  const doc = await buildPPMP_Doc(record);
  doc.save(`PPMP_${record.ppmp_no}_${String(record.end_user).replace(/[^\w-]+/g, '_')}.pdf`);
}

// ---------------------------------------------------------------
// APP PDF (GPPB format)
// ---------------------------------------------------------------
export async function buildAPP_PDF(targetYear = null, appRecordOverride = null) {
  const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
  const approved = records.filter((r) => r.status === 'Completed');

  if (approved.length === 0) {
    window.alert('No fully approved PPMPs available to generate the Annual Procurement Plan.');
    return null;
  }

  const fiscalYear = String(targetYear || approved[0]?.fiscal_year || new Date().getFullYear());
  // Only the latest approved PPMP of each office goes into the APP
  const relevantRecords = getLatestApprovedPpmpPerOffice(approved, fiscalYear);
  const appRecord = appRecordOverride || getAppRecord(fiscalYear) || {};
  const isFinalApp = appRecord.status === 'Completed';

  const appItems = [];
  relevantRecords.forEach((r) => {
    getRecordItems(r).forEach((it) => appItems.push({ ...it, end_user: r.end_user || 'N/A' }));
  });

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const usableWidth = pageWidth - MARGIN * 2;

  const bannerH = await drawBanner(doc, pageWidth, 25);
  let currentY = bannerH ? 5 + bannerH + 8 : 25;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(`ANNUAL PROCUREMENT PLAN FOR FY ${fiscalYear}`, pageWidth / 2, currentY, { align: 'center' });

  // Indicative while in review; Final once the RD has approved
  currentY += 6;
  doc.setFontSize(9);
  doc.rect(pageWidth / 2 - 38, currentY - 3.5, 4, 4);
  if (!isFinalApp) doc.text('X', pageWidth / 2 - 37, currentY - 0.5);
  doc.text('INDICATIVE', pageWidth / 2 - 32, currentY);

  doc.rect(pageWidth / 2 + 5, currentY - 3.5, 4, 4);
  if (isFinalApp) doc.text('X', pageWidth / 2 + 6, currentY - 0.5);
  doc.text('FINAL', pageWidth / 2 + 11, currentY);

  currentY += 8;

  const sectionOf = appSectionOf;
  const generalItems = appItems.filter((it) => sectionOf(it) === 'general');
  const miscItems = appItems.filter((it) => sectionOf(it) === 'misc');
  const cseItems = appItems.filter((it) => sectionOf(it) === 'cse');

  const headers = [
    [
      { content: 'PROCUREMENT PROJECT DETAILS', colSpan: 6, styles: centered },
      { content: 'PROJECTED TIMELINE (MM/YYYY)', colSpan: 4, styles: centered },
      { content: 'FUNDING DETAILS', colSpan: 2, styles: centered },
      { content: 'PROCUREMENT STRATEGY OR TOOLS', rowSpan: 2, styles: centeredMiddle },
      { content: 'REMARKS\n(Other relevant descriptions of the procurement project, if applicable)', rowSpan: 2, styles: centeredMiddle }
    ],
    [
      'Project Title',
      'End-User or Implementing Unit',
      'General Description of the Project',
      'Mode of Procurement',
      'To be covered by an Early Procurement Activity? (Yes/No)',
      'Criteria for Bid Evaluation\n(Including Sustainability and Domestic Preference)',
      'Advertisement/Posting of IB/REI',
      'Submission/Opening of Bids',
      'Notice of Award',
      'Contract Signing',
      'Source of Fund',
      'Estimated Budget / Approved Budget for the Contract (PhP)'
    ],
    Array.from({ length: 14 }, (_, i) => `Column ${i + 1}`)
  ];

  const formatAppRow = (it) => [
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
    peso(parseBudget(it.budget)),
    Array.isArray(it.strategies) ? it.strategies.join('\n') : (it.strategies || ''),
    it.remarks || ''
  ];

  const emptyRow = () => Array(14).fill('');
  const sectionHeader = (text) => [{
    content: text, colSpan: 14, styles: { fontStyle: 'bold', fillColor: [245, 245, 245], halign: 'left' }
  }];
  const section = (title, list) => [sectionHeader(title), ...(list.length ? list.map(formatAppRow) : [emptyRow()])];

  const totalBudget = calculateDeduplicatedBudget(appItems);

  const body = [
    ...section(APP_SECTION_TITLES.general, generalItems),
    ...section(APP_SECTION_TITLES.misc, miscItems),
    ...section(APP_SECTION_TITLES.cse, cseItems),
    [
      { content: 'TOTAL BUDGET:', colSpan: 11, styles: { halign: 'right', fontStyle: 'bold' } },
      { content: peso(totalBudget), styles: { halign: 'right', fontStyle: 'bold' } },
      '', ''
    ]
  ];

  const columnStyles = weightedColumnStyles(
    [9, 9.5, 10.5, 9, 6.5, 9.5, 6.5, 6.5, 6.5, 6.5, 7, 9.5, 9, 7],
    usableWidth
  );
  columnStyles[11].halign = 'right';

  const tableEndY = renderTable(doc, {
    ...TABLE_BASE,
    startY: currentY,
    head: headers,
    body,
    tableWidth: usableWidth,
    styles: { ...TABLE_BASE.styles, fontSize: 5.5 },
    headStyles: { fillColor: [255, 255, 255], fontStyle: 'bold', fontSize: 5.5, halign: 'center', valign: 'middle', cellPadding: 1.5 },
    columnStyles
  });

  // Signatories
  let finalY = (tableEndY ?? currentY + 60) + 12;
  if (finalY + 65 > pageHeight) {
    doc.addPage();
    finalY = 20;
  }
  doc.setFontSize(7);

  const nameOf = (person, fallback) => (person?.name ? person.name.toUpperCase() : fallback);
  const dateOf = (ts) => (ts ? new Date(Number(ts)).toLocaleDateString() : '');

  const prepDate = dateOf(appRecord.submitted_at) || new Date().toLocaleDateString();
  const ardDate = dateOf(appRecord.ard_approved_at);
  const rdDate = dateOf(appRecord.approved_at);

  drawSignatory(doc, {
    labelX: MARGIN, lineFrom: MARGIN, lineTo: MARGIN + 60, centerX: MARGIN + 30, y: finalY,
    label: 'Prepared by / Submitted by:',
    name: nameOf(appRecord.submitted_by, 'SUPPLY OFFICER II'),
    role: 'Supply Officer II / BAC Secretariat',
    extras: [['Date: ' + prepDate, 28]]
  });
  drawSignatory(doc, {
    labelX: pageWidth / 2 - 30, lineFrom: pageWidth / 2 - 35, lineTo: pageWidth / 2 + 25, centerX: pageWidth / 2 - 5, y: finalY,
    label: 'Endorsed by:',
    name: nameOf(appRecord.ard_approved_by, 'ASSISTANT REGIONAL DIRECTOR'),
    role: 'Assistant Regional Director / BAC Chairperson',
    extras: ardDate ? [['Date: ' + ardDate, 28]] : []
  });
  drawSignatory(doc, {
    labelX: pageWidth - 70, lineFrom: pageWidth - 70, lineTo: pageWidth - MARGIN, centerX: pageWidth - 35, y: finalY,
    label: 'Approved by:',
    name: nameOf(appRecord.approved_by, 'REGIONAL DIRECTOR'),
    role: 'Regional Director / Head of the Procuring Entity',
    extras: rdDate ? [['Date: ' + rdDate, 28]] : []
  });

  return { doc, fiscalYear, fileName: `APP_FY_${fiscalYear}_DICT.pdf` };
}

export async function generateAPP_PDF(year = null) {
  const built = await buildAPP_PDF(year);
  if (built) built.doc.save(built.fileName);
}

export async function previewAPP_PDF(year = null, appRecordOverride = null) {
  const built = await buildAPP_PDF(year, appRecordOverride);
  if (!built) return null;
  return { blob: built.doc.output('blob'), fiscalYear: built.fiscalYear, fileName: built.fileName };
}

export function formatMonthYear(dateVal) {
  if (!dateVal) return '';
  const str = String(dateVal).trim();
  if (/^[A-Za-z]{3}-\d{2}$/i.test(str)) return str;
  const m = str.match(/^(\d{4})-(\d{1,2})/);
  if (m) {
    const year = m[1].slice(-2);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthIdx = parseInt(m[2], 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${months[monthIdx]}-${year}`;
    }
  }
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const yy = String(d.getFullYear()).slice(-2);
    return `${months[d.getMonth()]}-${yy}`;
  }
  return str;
}