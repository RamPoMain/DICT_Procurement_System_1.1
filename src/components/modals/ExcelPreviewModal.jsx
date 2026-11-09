import React, { useState, useEffect } from 'react';
import FileStore from '../../utils/fileStore.js';
import FilePreviewModal from './FilePreviewModal.jsx';
import { exportPPMP_Excel } from '../../utils/entriesExport.js';
import {
  formatPesoExact,
  parseBudgetNumber,
  getRecordItems,
  calculateDeduplicatedBudget,
  isPpmpDraft
} from '../../utils/procurementRules';

const hasDoc = (doc) => !!doc && !!(doc.fileId || doc.dataUrl);

function saveBlob(url, fileName) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// "Attached Supporting Documents" cell: name opens the file in preview modal, arrow downloads it.
function DocList({ item, notify, onPreviewDoc }) {
  const docs = Array.isArray(item.supporting_documents) ? item.supporting_documents : [];
  if (docs.length === 0) return <span className="ep-none">None</span>;

  const resolve = async (doc) => {
    try {
      const blob = await FileStore.docBlob(doc);
      if (blob) return blob;
    } catch { /* fall through */ }
    notify('This file could not be read. Re-attach it by editing the item.');
    return null;
  };

  const openDoc = (doc) => {
    if (onPreviewDoc) {
      onPreviewDoc(doc);
    }
  };

  const downloadDoc = async (doc) => {
    const blob = await resolve(doc);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    saveBlob(url, doc.name || 'document');
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <ul className="ep-list ep-doc-list">
      {docs.map((doc, index) => {
        const name = (doc && doc.name) || 'Document';
        if (!hasDoc(doc)) return <li key={index}>{name}</li>;
        return (
          <li key={index} className="ep-doc-item">
            <button type="button" className="ep-doc-link" title={`Preview ${name}`} onClick={() => openDoc(doc)}>
              {name}
            </button>
            <button type="button" className="ep-doc-download" title={`Download ${name}`} aria-label={`Download ${name}`} onClick={() => downloadDoc(doc)}>
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none">
                <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ValueList({ values }) {
  const list = (Array.isArray(values) ? values : [values])
    .map((v) => String(v == null ? '' : v).trim())
    .filter(Boolean);
  if (list.length === 0) return <span className="ep-none">None</span>;
  return <ul className="ep-list">{list.map((v, i) => <li key={i}>{v}</li>)}</ul>;
}

const SIGNATORIES = [
  {
    label: 'Prepared by / Submitted by:',
    name: 'JAYMARK D. DUMIO',
    lines: ['Focal, ICT Literacy Competency and Development Bureau X'],
    date: true
  },
  { label: 'Endorsed by:', name: 'EUGENE C. RAPOSALA III', lines: ['Chief, Technical Operations Division'] },
  { label: 'Certified Funds Available:', name: 'BRYAN JOHN M. SABLAS', lines: ['Budget Officer II'] }
];

/**
 * Keeps a rendering problem inside the preview from blanking the whole page: it shows the error message
 * in place of the sheet (and logs the details to the browser console) instead.
 */
export class PreviewBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('PPMP preview failed to render:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" style={{ padding: 16, fontSize: 13 }}>
          The PPMP preview could not be displayed: {String((this.state.error && this.state.error.message) || this.state.error)}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * The Excel-style sheet of one PPMP, without any modal around it. Used by the Excel preview popup and by
 * the approval dialog, so approvers see exactly the same thing. Criteria and Strategies columns show only
 * while the PPMP is still a Draft.
 */
export function PpmpSheet({ record, notify = () => {}, onPreviewDoc }) {
  const items = getRecordItems(record);
  const showCS = isPpmpDraft(record);
  const isIndicative = record.is_indicative === 'Indicative';
  const isFinal = record.is_indicative === 'Final';
  const total = formatPesoExact(calculateDeduplicatedBudget(items));
  const labelSpan = showCS ? 12 : 11;

  // "Column 1..n" row: the hidden Criteria (6) and Strategies (14) columns are skipped in the numbering.
  let shown = 0;
  const columnLabels = Array.from({ length: 17 }, (_, i) => {
    const isCS = i + 1 === 6 || i + 1 === 14;
    if (isCS && !showCS) return { hidden: true, text: '' };
    shown += 1;
    return { hidden: false, text: `Column ${shown}` };
  });

  return (
    <div className="excel-preview-sheet">
      <div className="excel-preview-banner">
        <img src="/images/header-banner.png" alt="DICT Header Banner" />
      </div>

      <h2>PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. {record.ppmp_no || 'N/A'}</h2>

      <div className="excel-preview-checks">
        <span><span className="excel-check-box">{isIndicative ? 'X' : ''}</span> INDICATIVE</span>
        <span><span className="excel-check-box">{isFinal ? 'X' : ''}</span> FINAL</span>
      </div>

      <div className="excel-preview-meta">
        <p>Fiscal Year : {record.fiscal_year || 'N/A'}</p>
        <p>End-User or Implementing Unit: {record.end_user || 'N/A'}</p>
      </div>

      <div className="excel-preview-table-wrap">
        <table className={`excel-preview-table${showCS ? '' : ' ep-hide-cs'}`}>
          <thead>
            <tr>
              <th colSpan={showCS ? 6 : 5}>PROCUREMENT PROJECT DETAILS</th>
              <th colSpan={5}>PROJECTED TIMELINE (MM/YYYY)</th>
              <th colSpan={2}>FUNDING DETAILS</th>
              <th rowSpan={2} className="ep-cs-col">PROCUREMENT STRATEGIES AND TOOLS</th>
              <th rowSpan={2}>ATTACHED SUPPORTING DOCUMENTS</th>
              <th rowSpan={2}>GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT</th>
              <th rowSpan={2}>REMARKS</th>
            </tr>
            <tr>
              <th>General Description and Objective of the Project to be Procured</th>
              <th>Type of the Project to be Procured</th>
              <th>Quantity and Size of the Project to be Procured</th>
              <th>Recommended Mode of Procurement</th>
              <th>Pre-Procurement Conference (Yes/No)</th>
              <th className="ep-cs-col">Criteria for Bid Evaluation</th>
              <th>Advertisement/Posting of IB/REI</th>
              <th>Submission/Opening of Bids</th>
              <th>Notice of Award</th>
              <th>Contract Signing</th>
              <th>Expected Delivery/ Implementation Period</th>
              <th>Source of Funds</th>
              <th>Estimated Budget / Authorized Budgetary Allocation (PhP)</th>
            </tr>
            <tr>
              {columnLabels.map((c, i) => (
                <th key={i} className={c.hidden ? 'ep-cs-col' : undefined}>{c.text}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={item.id ?? idx} className="ep-item-row">
                <td>{item.project_description || ''}</td>
                <td>{item.project_type || ''}</td>
                <td>{item.quantity_size || ''}</td>
                <td>{item.mode || ''}</td>
                <td>{item.pre_procurement || ''}</td>
                <td className="ep-cs-col">{showCS ? (item.bid_evaluation_criteria || 'N/A') : ''}</td>
                <td>{item.start_date || ''}</td>
                <td>{item.bid_opening_date || ''}</td>
                <td>{item.notice_of_award_date || ''}</td>
                <td>{item.end_date || ''}</td>
                <td>{item.delivery_period || ''}</td>
                <td>{item.fund_source || ''}</td>
                <td>{formatPesoExact(parseBudgetNumber(item.budget))}</td>
                <td className="ep-cs-col" style={{ textAlign: 'center' }}>
                  {showCS ? <ValueList values={item.strategies} /> : ''}
                </td>
                <td>
                  {!(Array.isArray(item.supporting_documents) && item.supporting_documents.length > 0) && showCS ? (
                    <span className="ep-none ep-needs-doc" title="Required before this PPMP can be submitted for approval">
                      Needs document
                    </span>
                  ) : (
                    <DocList item={item} notify={notify} onPreviewDoc={onPreviewDoc} />
                  )}
                </td>
                <td>{item.general_requirements || ''}</td>
                <td>{item.remarks || ''}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={labelSpan} className="excel-total-label">TOTAL BUDGET:</td>
              <td className="excel-total-value">{total}</td>
              <td className="ep-cs-col" />
              <td />
              <td />
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="excel-preview-signatures">
        {SIGNATORIES.map((s) => (
          <div key={s.label}>
            <p>{s.label}</p>
            <span />
            <strong>{s.name}</strong>
            <small>Signature over Printed Name</small>
            {s.lines.map((l) => <small key={l}>{l}</small>)}
            {s.date && <small>Date: {new Date().toLocaleDateString()}</small>}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Read-only Excel-style preview of one PPMP.
 * Criteria and Strategies columns show only while the PPMP is still a Draft.
 */
export default function ExcelPreviewModal({ record, onClose, onOpenRequest, notify = () => {} }) {
  const [previewDoc, setPreviewDoc] = useState(null);

  useEffect(() => {
    if (!record) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [record, onClose]);

  if (!record) return null;

  const exportExcel = async () => {
    try {
      await exportPPMP_Excel(record);
    } catch (err) {
      console.error('PPMP Excel export failed:', err);
      notify('The Excel file could not be exported.');
    }
  };

  const iconProps = { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 2 };

  return (
    <div
      className="excel-preview-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="excel-preview-modal" role="dialog" aria-modal="true" aria-labelledby="excelPreviewTitle">
        <div className="excel-preview-header">
          <div>
            <h3 id="excelPreviewTitle">Excel Preview</h3>
            <p>PPMP No. {record.ppmp_no || 'N/A'}</p>
          </div>
          <div className="excel-preview-actions">
            <button
              type="button"
              className="db-action-btn"
              title="Download Excel (.xlsx)"
              onClick={exportExcel}
              style={{ background: '#10b981', color: '#fff', borderColor: '#10b981' }}
            >
              <svg {...iconProps}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span style={{ fontSize: 12, marginLeft: 4 }}>Export Excel</span>
            </button>
            <button type="button" className="db-action-btn" title="Open Full Request" onClick={() => onOpenRequest(record.id)}>
              <svg {...iconProps}>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <button type="button" className="db-action-btn" title="Close Preview" onClick={onClose}>
              <svg {...iconProps}><path d="M6 6L18 18M18 6L6 18" strokeLinecap="round" /></svg>
            </button>
          </div>
        </div>

        <div className="excel-preview-scroll">
          <PpmpSheet record={record} notify={notify} onPreviewDoc={setPreviewDoc} />
        </div>
      </div>

      <FilePreviewModal
        isOpen={!!previewDoc}
        onClose={() => setPreviewDoc(null)}
        doc={previewDoc}
      />
    </div>
  );
}