import React, { useState, useRef, useEffect, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  downloadBulkTemplate,
  analyzeRows,
  commitImportedItems,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS
} from '../../utils/bulkImport.js';
import { getNextPpmpNumber } from '../../utils/ppmpNumber.js';
import {
  isAppFinal,
  getRecordItems,
  getNewRequestTarget,
  newRequestBlockedMessage
} from '../../utils/procurementRules.js';

function readRecords() {
  try {
    return JSON.parse(localStorage.getItem('procurement_records')) || [];
  } catch {
    return [];
  }
}

// Only this year and next year can be picked for a new PPMP.
function pickAllowedYear(preferred) {
  const thisYear = new Date().getFullYear();
  const y = Number(preferred);
  return String(y === thisYear || y === thisYear + 1 ? y : thisYear);
}

export default function BulkImportModal({ isOpen, onClose, headerData, recordId, onSuccess }) {
  const { user } = useAuth();
  const [downloading, setDownloading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [reviewResult, setReviewResult] = useState(null); // { fatal, ready, problems, total }
  const [ppmpType, setPpmpType] = useState(headerData?.is_indicative || 'Indicative');
  const [fiscalYear, setFiscalYear] = useState(pickAllowedYear(headerData?.fiscal_year));
  const [errorToast, setErrorToast] = useState('');
  const fileInputRef = useRef(null);

  const isAddingToExisting = !!recordId;
  const thisYear = new Date().getFullYear();
  const currentOffice = headerData?.end_user || user?.office || 'DICT';

  // Start fresh every time the dialog opens (it stays mounted on the Dashboard).
  useEffect(() => {
    if (!isOpen) return;
    setReviewResult(null);
    setSelectedFile(null);
    setErrorToast('');
    setParsing(false);
    setPpmpType(headerData?.is_indicative || 'Indicative');
    setFiscalYear(pickAllowedYear(headerData?.fiscal_year));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Esc closes only this dialog, not the form behind it.
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      handleClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // What this import will do (same rules as the request form), based on the latest PPMP of this
  // office + fiscal year: add to a Draft, create the next PPMP from an approved one, or be blocked.
  const plan = useMemo(
    () => (isAddingToExisting || !isOpen
      ? null
      : getNewRequestTarget(readRecords(), currentOffice, fiscalYear)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isOpen, isAddingToExisting, currentOffice, fiscalYear]
  );

  // The real number the import will use (matches what commitImportedItems issues).
  const ppmpNo = useMemo(
    () => {
      if (isAddingToExisting) return headerData?.ppmp_no || '-';
      if (plan?.mode === 'append') return plan.record.ppmp_no;
      return getNextPpmpNumber(readRecords(), currentOffice, fiscalYear);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isOpen, isAddingToExisting, headerData?.ppmp_no, currentOffice, fiscalYear, plan]
  );

  // Fiscal years a new PPMP can be planned for: this year and next year only.
  const yearOptions = useMemo(
    () => [String(thisYear), String(thisYear + 1)],
    [thisYear]
  );

  const yearIsClosed = !isAddingToExisting && isOpen && isAppFinal(fiscalYear);
  const planBlocked = plan?.mode === 'blocked';

  if (!isOpen) return null;

  // Adding to a Draft keeps that Draft's type, so the type picker follows it.
  const effectiveType = plan?.mode === 'append' ? plan.record.is_indicative : ppmpType;

  const currentYear = isAddingToExisting ? String(headerData?.fiscal_year || fiscalYear) : fiscalYear;

  const handleDownload = async () => {
    try {
      setDownloading(true);
      await downloadBulkTemplate({
        ppmp_no: ppmpNo,
        fiscal_year: currentYear,
        end_user: currentOffice,
        is_indicative: effectiveType
      });
    } catch (err) {
      setErrorToast('Could not download template: ' + (err.message || 'Unknown error'));
    } finally {
      setDownloading(false);
    }
  };

  const processFile = (file) => {
    if (!file) return;

    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      setErrorToast('Please choose an Excel (.xlsx, .xls) or .csv file.');
      return;
    }

    if (file.size > MAX_IMPORT_BYTES) {
      setErrorToast('File size is larger than 5 MB. Please upload a smaller file.');
      return;
    }

    setParsing(true);
    setSelectedFile(file);

    const reader = new FileReader();
    reader.onerror = () => {
      setParsing(false);
      setErrorToast('Could not read the file.');
    };

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames.includes('PPMP Items')
          ? 'PPMP Items'
          : workbook.SheetNames[0];

        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
          header: 1,
          raw: true,
          defval: ''
        });

        const analysis = analyzeRows(rows);
        setReviewResult(analysis);
      } catch (err) {
        console.error('File parsing error:', err);
        setErrorToast('Could not parse the spreadsheet. Make sure it is a valid Excel file.');
      } finally {
        setParsing(false);
      }
    };

    reader.readAsArrayBuffer(file);
  };

  const handleImport = () => {
    if (!reviewResult || !reviewResult.ready.length) return;

    try {
      const result = commitImportedItems({
        items: reviewResult.ready.map(r => r.item),
        headerData: {
          ...headerData,
          ppmp_no: ppmpNo,
          fiscal_year: currentYear,
          end_user: currentOffice,
          is_indicative: effectiveType
        },
        user,
        targetRecordId: recordId
      });

      if (onSuccess) {
        onSuccess(result);
      }
      handleClose();
    } catch (err) {
      setErrorToast(err.message || 'Could not commit imported items.');
    }
  };

  const handleClose = () => {
    setReviewResult(null);
    setSelectedFile(null);
    setErrorToast('');
    onClose();
  };

  const carriedCount = plan?.mode === 'new-version' ? getRecordItems(plan.record).length : 0;
  let targetDescription;
  if (isAddingToExisting) {
    targetDescription = `Items will be added to existing PPMP No. ${ppmpNo}.`;
  } else if (plan?.mode === 'append') {
    targetDescription = `Items will be added to the existing Draft PPMP No. ${ppmpNo}, FY ${currentYear}, ${currentOffice}.`;
  } else if (plan?.mode === 'new-version') {
    targetDescription = `Items will create a new Draft PPMP: No. ${ppmpNo}, FY ${currentYear}, ${currentOffice}, ` +
      `carrying over the ${carriedCount} ${carriedCount === 1 ? 'item' : 'items'} of approved PPMP No. ${plan.record.ppmp_no}.`;
  } else if (planBlocked) {
    targetDescription = `PPMP No. ${plan.record.ppmp_no} for FY ${currentYear} is under review, so nothing can be imported yet.`;
  } else {
    targetDescription = `Items will create a new Draft PPMP: No. ${ppmpNo}, FY ${currentYear}, ${currentOffice}.`;
  }

  return (
    <div className="bi-overlay" onClick={(e) => e.target.classList.contains('bi-overlay') && handleClose()}>
      <div className="bi-dialog" role="dialog" aria-modal="true" aria-labelledby="bulkImportTitle">
        {errorToast && (
          <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, background: '#fee2e2', color: '#dc2626', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{errorToast}</span>
            <button type="button" onClick={() => setErrorToast('')} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontWeight: 'bold' }}>&times;</button>
          </div>
        )}

        {!reviewResult ? (
          <>
            <h3 id="bulkImportTitle">Bulk import from Excel</h3>
            <p className="bi-file">{targetDescription}</p>

            <div className="bi-dialog-body">
              {/* Step 1: Download */}
              <div className="bi-step">
                <span className="bi-num">1</span>
                <div className="bi-step-main">
                  <strong>Download the template</strong>
                  <p>Fill in one row per item. The Instructions sheet inside the workbook lists all allowed options.</p>
                  <button
                    type="button"
                    className="bi-btn is-secondary"
                    onClick={handleDownload}
                    disabled={downloading}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                      <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {downloading ? 'Generating template...' : 'Download template (.xlsx)'}
                  </button>
                </div>
              </div>

              {/* Step 2: Upload */}
              <div className="bi-step">
                <span className="bi-num">2</span>
                <div className="bi-step-main">
                  <strong>Upload the filled file</strong>
                  <p>Every row will be checked against government procurement guidelines before anything is saved.</p>

                  {!isAddingToExisting && (
                    <>
                      <label className="bi-type-field">
                        <span>Fiscal year</span>
                        <select value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)}>
                          {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
                        </select>
                      </label>
                      <label className="bi-type-field">
                        <span>PPMP type for these items</span>
                        <select value={effectiveType} disabled={plan?.mode === 'append'} onChange={(e) => setPpmpType(e.target.value)}>
                          <option value="Indicative">Indicative</option>
                          <option value="Final">Final</option>
                        </select>
                      </label>
                      {!yearIsClosed && planBlocked && (
                        <p className="bi-fatal" style={{ marginTop: 8 }}>
                          {newRequestBlockedMessage(plan.record, fiscalYear)}
                        </p>
                      )}
                      {yearIsClosed && (
                        <p className="bi-fatal" style={{ marginTop: 8 }}>
                          The APP for FY {fiscalYear} is already final, so a new PPMP cannot be created under it.
                          Choose another fiscal year.
                        </p>
                      )}
                    </>
                  )}

                  <div
                    className={`bi-drop ${dragOver ? 'is-over' : ''}`}
                    tabIndex={0}
                    role="button"
                    onClick={() => fileInputRef.current?.click()}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(false);
                      if (e.dataTransfer.files?.length) {
                        processFile(e.dataTransfer.files[0]);
                      }
                    }}
                  >
                    <span className="bi-drop-text">
                      Drop the file here or <span className="bi-link">browse</span>
                    </span>
                    <span className="bi-drop-sub">
                      .xlsx, .xls or .csv &middot; up to 5 MB &middot; up to {MAX_IMPORT_ROWS} items
                    </span>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    hidden
                    onChange={(e) => {
                      if (e.target.files?.length) {
                        processFile(e.target.files[0]);
                        e.target.value = '';
                      }
                    }}
                  />
                  {parsing && <p style={{ marginTop: 8, fontSize: 13, color: '#3b82f6' }}>Parsing and validating spreadsheet rows...</p>}
                </div>
              </div>
            </div>

            <div className="bi-dialog-actions">
              <span className="bi-spacer" />
              <button type="button" className="bi-btn is-secondary" onClick={handleClose}>
                Close
              </button>
            </div>
          </>
        ) : (
          /* Review Step */
          <>
            <h3 id="bulkImportTitle">Review import</h3>
            <p className="bi-file">{selectedFile?.name}</p>

            <div className="bi-dialog-body">
              {reviewResult.fatal ? (
                <p className="bi-fatal">{reviewResult.fatal}</p>
              ) : (
                <>
                  <div className="bi-summary">
                    <span className="bi-chip is-ok">{reviewResult.ready.length} ready</span>
                    {reviewResult.problems.length > 0 && (
                      <span className="bi-chip is-bad">{reviewResult.problems.length} with problems</span>
                    )}
                    <span className="bi-chip">{reviewResult.total} rows read</span>
                  </div>

                  {reviewResult.problems.length > 0 && (
                    <>
                      <h4 className="bi-sub">Rows that need fixing (they will be skipped)</h4>
                      <ul className="bi-problems">
                        {reviewResult.problems.map((p) => (
                          <li key={p.rowNumber}>
                            <strong>Row {p.rowNumber}</strong>
                            <ul>
                              {p.errors.map((err, idx) => (
                                <li key={idx}>{err}</li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {reviewResult.ready.length > 0 && (
                    <>
                      <h4 className="bi-sub">Ready to import</h4>
                      <div className="bi-table-wrap">
                        <table className="bi-table">
                          <thead>
                            <tr>
                              <th>Row</th>
                              <th>Description</th>
                              <th>Type</th>
                              <th>Mode</th>
                              <th>Budget</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reviewResult.ready.slice(0, 10).map((r) => (
                              <tr key={r.rowNumber}>
                                <td>{r.rowNumber}</td>
                                <td>{r.item.project_description}</td>
                                <td>{r.item.project_type}</td>
                                <td>{r.item.mode}</td>
                                <td>₱{Number(r.item.budget || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {reviewResult.ready.length > 10 && (
                        <p className="bi-more">and {reviewResult.ready.length - 10} more items</p>
                      )}
                      <p className="bi-note">
                        {targetDescription} Supporting documents cannot be attached inside the file, so please attach them to each item via Edit before submitting for approval.
                      </p>
                    </>
                  )}
                </>
              )}
            </div>

            <div className="bi-dialog-actions">
              <button
                type="button"
                className="bi-btn is-secondary"
                onClick={() => {
                  setReviewResult(null);
                  setSelectedFile(null);
                }}
              >
                Choose another file
              </button>
              <span className="bi-spacer" />
              <button type="button" className="bi-btn is-secondary" onClick={handleClose}>
                {reviewResult.ready.length > 0 ? 'Cancel' : 'Close'}
              </button>
              {reviewResult.ready.length > 0 && (
                <button type="button" className="bi-btn" onClick={handleImport} disabled={yearIsClosed || planBlocked}>
                  Import {reviewResult.ready.length} {reviewResult.ready.length === 1 ? 'item' : 'items'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}