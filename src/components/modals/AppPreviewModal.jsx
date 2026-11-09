import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  getAppRecord,
  saveAppRecord,
  getLatestApprovedPpmpPerOffice,
  getRecordItems,
  parseBudgetNumber,
  calculateDeduplicatedBudget
} from '../../utils/procurementRules.js';
import { previewAPP_PDF, generateAPP_PDF, formatMonthYear } from '../../utils/pdfGenerator.js';
import { exportStandardAppExcel, exportPhilGepsAppExcel } from '../../utils/appTemplateExport.js';
import { testSendToDtms } from '../../utils/dtmsClient.js';

export default function AppPreviewModal({ isOpen, onClose, fiscalYear, onUpdated }) {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('sheet'); // 'sheet' | 'pdf'
  const [blobUrl, setBlobUrl] = useState(null);
  const [appRecord, setAppRecord] = useState(null);
  const [allItems, setAllItems] = useState([]);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [exportNotice, setExportNotice] = useState('');
  const [showDtmsTestConfirm, setShowDtmsTestConfirm] = useState(false);
  const [dtmsTesting, setDtmsTesting] = useState(false);

  const showToast = (msg) => {
    setExportNotice(msg);
    setTimeout(() => setExportNotice(''), 3500);
  };

  useEffect(() => {
    if (!isOpen || !fiscalYear) return;
    const rec = getAppRecord(fiscalYear);
    setAppRecord(rec);

    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const approved = records.filter(r => r.status === 'Completed');
    const relevantRecords = getLatestApprovedPpmpPerOffice(approved, fiscalYear);

    const items = [];
    relevantRecords.forEach(r => {
      getRecordItems(r).forEach(it => items.push({ ...it, end_user: r.end_user }));
    });
    setAllItems(items);

    previewAPP_PDF(fiscalYear).then(res => {
      if (res?.blob) {
        const u = URL.createObjectURL(res.blob);
        setBlobUrl(u);
      }
    });

    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [isOpen, fiscalYear]);

  if (!isOpen || !appRecord) return null;

  // Split items into standard DBM categories
  const generalItems = [];
  const miscItems = [];
  const cseItems = [];

  allItems.forEach(it => {
    const eu = String(it.end_user || '').toLowerCase();
    const mode = String(it.mode || '').toLowerCase();
    if (eu.includes('general administration') || eu.includes('gass') || it.general_requirements === 'Common Supplies and Equipment') {
      cseItems.push(it);
    } else if (mode.includes('direct acquisition') || it.general_requirements === 'Miscellaneous') {
      miscItems.push(it);
    } else {
      generalItems.push(it);
    }
  });

  const totalCalculatedBudget = calculateDeduplicatedBudget(allItems);
  const isFinal = appRecord.status === 'Completed';

  const handleAction = (action) => {
    if (action !== 'approve' && !remarks.trim()) {
      setReviewError('Remarks are required to reject or add remarks.');
      return;
    }
    const updated = { ...appRecord };
    if (!Array.isArray(updated.remarksHistory)) updated.remarksHistory = [];

    updated.remarksHistory.push({
      stage: user.role,
      role: user.role,
      name: user.roleName,
      action,
      remarks: remarks || 'Approved.',
      date: new Date().toLocaleDateString(),
      at: Date.now()
    });

    if (action === 'reject') {
      updated.status = 'Draft';
      updated.currentApproverRole = null;
      updated.returned_for_revision = true;
      updated.rejected_by = { name: user.roleName, role: user.role };
      updated.rejected_at = Date.now();
    } else if (action === 'approve') {
      if (user.role === 'ARD') {
        updated.currentApproverRole = 'RD';
        updated.ard_approved_by = { name: user.roleName, role: user.role };
        updated.ard_approved_at = Date.now();
      } else if (user.role === 'RD') {
        updated.status = 'Completed';
        updated.currentApproverRole = 'None';
        updated.returned_for_revision = false;
        updated.approved_by = { name: user.roleName, role: user.role };
        updated.approved_at = Date.now();
      }
    }

    saveAppRecord(updated);
    setAppRecord(updated);
    setShowReviewDialog(false);
    if (onUpdated) onUpdated();
  };

  const submitApp = () => {
    const updated = {
      ...appRecord,
      status: 'For Approval',
      currentApproverRole: 'ARD',
      returned_for_revision: false,
      submitted_by: { name: user.roleName, role: user.role },
      submitted_at: Date.now()
    };
    saveAppRecord(updated);
    setAppRecord(updated);
    if (onUpdated) onUpdated();
  };

  const handleDtmsTest = async () => {
    if (dtmsTesting) return;
    setShowDtmsTestConfirm(false);
    setDtmsTesting(true);
    try {
      const result = await testSendToDtms('APP', appRecord, user);
      showToast(`DTMS test document sent. Tracking no. ${result.tracknumber}`);
    } catch (e) {
      showToast(`DTMS test send failed: ${e.message}`);
    } finally {
      setDtmsTesting(false);
    }
  };

  const renderTableRows = (list) => {
    if (list.length === 0) {
      return (
        <tr>
          {Array(12).fill(0).map((_, i) => (
            <td key={i} style={{ height: 24, padding: '4px 6px' }}>&nbsp;</td>
          ))}
        </tr>
      );
    }

    return list.map((it, idx) => {
      const startMmmYy = formatMonthYear(it.start_date || it.bid_opening_date || `${fiscalYear}-03-01`);
      const endMmmYy = formatMonthYear(it.end_date || it.notice_of_award_date || it.start_date || `${fiscalYear}-03-01`);
      const budgetVal = parseBudgetNumber(it.budget);
      const title = it.quantity_size ? `${it.project_description} (${it.quantity_size})` : (it.project_description || 'N/A');

      return (
        <tr key={idx}>
          <td style={{ fontWeight: 500, minWidth: 200 }}>{title}</td>
          <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>{it.end_user || 'N/A'}</td>
          <td style={{ textAlign: 'center' }}>{it.project_type || 'Goods'}</td>
          <td style={{ textAlign: 'center' }}>{it.mode || 'N/A'}</td>
          <td style={{ textAlign: 'center' }}>{it.pre_procurement || 'No'}</td>
          <td style={{ textAlign: 'center' }}>{it.bid_evaluation_criteria || 'LCB/LCRB'}</td>
          <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>{startMmmYy}</td>
          <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>{endMmmYy}</td>
          <td style={{ fontSize: 10 }}>{it.fund_source || `SAGF ${fiscalYear} - Current Appropriation`}</td>
          <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
            ₱{budgetVal.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </td>
          <td style={{ textAlign: 'center' }}>{Array.isArray(it.strategies) ? it.strategies.join(', ') : (it.strategies || 'Renewal')}</td>
          <td>{it.remarks || ''}</td>
        </tr>
      );
    });
  };

  return (
    <div className="app-preview-overlay show">
      <div className="app-preview-modal">
        <div className="app-preview-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h3>Annual Procurement Plan (APP) — FY {fiscalYear}</h3>
            <span className={`db-status-pill ${appRecord.status === 'Completed' ? 'is-completed' : (appRecord.status === 'For Approval' ? 'is-pending' : 'is-draft')}`}>
              {appRecord.status === 'Completed' ? 'Final (Approved)' : (appRecord.status === 'For Approval' ? `In Review (${appRecord.currentApproverRole})` : 'Draft')}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="app-view-toggle">
              <button
                type="button"
                className={`app-view-tab ${activeTab === 'sheet' ? 'active' : ''}`}
                onClick={() => setActiveTab('sheet')}
              >
                📊 Standard Sheet View (12-Col)
              </button>
              <button
                type="button"
                className={`app-view-tab ${activeTab === 'pdf' ? 'active' : ''}`}
                onClick={() => setActiveTab('pdf')}
              >
                📄 PDF Preview
              </button>
            </div>
            <button type="button" className="app-preview-x" onClick={onClose} aria-label="Close modal">&times;</button>
          </div>
        </div>

        {exportNotice && (
          <div style={{ padding: '6px 12px', background: '#dbeafe', color: '#1e40af', borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            {exportNotice}
          </div>
        )}

        <div className="app-preview-body">
          {activeTab === 'sheet' ? (
            <div className="app-sheet-container">
              {/* Header Banner matching image_db4b3df3.png */}
              <div className="app-sheet-header">
                <div className="app-sheet-banner-wrap">
                  <img src="/images/DICT-Logo.png" alt="DICT Logo" className="app-sheet-logo" onError={(e) => { e.target.style.display = 'none'; }} />
                  <div className="app-sheet-center-text">
                    <h4>Republic of the Philippines</h4>
                    <h3>DEPARTMENT OF INFORMATION AND COMMUNICATIONS TECHNOLOGY</h3>
                  </div>
                  <div style={{ width: 60 }} aria-hidden="true" />
                </div>

                <div className="app-sheet-title">
                  ANNUAL PROCUREMENT PLAN FOR FY {fiscalYear}
                </div>

                {/* Checkboxes matching image_db4b3df3.png */}
                <div className="app-sheet-checkboxes">
                  <label className="app-sheet-checkbox-item">
                    <span className="app-sheet-box">{!isFinal && !appRecord.is_updated ? 'X' : ''}</span>
                    <span>INDICATIVE</span>
                  </label>
                  <label className="app-sheet-checkbox-item">
                    <span className="app-sheet-box">{isFinal && !appRecord.is_updated ? 'X' : ''}</span>
                    <span>FINAL</span>
                  </label>
                  <label className="app-sheet-checkbox-item">
                    <span className="app-sheet-box checked">✓</span>
                    <span>UPDATED [Version No. 01]</span>
                  </label>
                </div>
              </div>

              {/* 12-Column Table matching image_db4b3df3.png */}
              <div className="app-sheet-table-wrap">
                <table className="app-sheet-table">
                  <thead>
                    <tr>
                      <th colSpan={6} className="app-group-head">PROCUREMENT PROJECT DETAILS</th>
                      <th colSpan={2} className="app-group-head">PROJECTED TIMELINE (MM/YYYY)</th>
                      <th colSpan={2} className="app-group-head">FUNDING DETAILS</th>
                      <th rowSpan={2} style={{ verticalAlign: 'middle', width: 140 }}>PROCUREMENT STRATEGY OR TOOLS</th>
                      <th rowSpan={2} style={{ verticalAlign: 'middle', width: 160 }}>
                        REMARKS<br />
                        <span style={{ fontSize: 9, fontWeight: 'normal' }}>(Other relevant descriptions of the procurement project, if applicable)</span>
                      </th>
                    </tr>
                    <tr>
                      <th style={{ minWidth: 180 }}>Project Title</th>
                      <th style={{ width: 110 }}>End-User or Implementing Unit</th>
                      <th style={{ width: 90 }}>General Description of the Project</th>
                      <th style={{ width: 110 }}>Mode of Procurement</th>
                      <th style={{ width: 80 }}>To be covered by an Early Procurement Activity? (Yes/No)</th>
                      <th style={{ width: 140 }}>Criteria for Bid Evaluation (Including Sustainability and Domestic Preference)</th>
                      <th style={{ width: 85 }}>Start of Procurement Activity</th>
                      <th style={{ width: 85 }}>End of Procurement Activity</th>
                      <th style={{ width: 130 }}>Source of Fund</th>
                      <th style={{ width: 120 }}>Estimated Budget / Approved Budget for the Contract (PhP)</th>
                    </tr>
                    <tr>
                      {Array.from({ length: 12 }, (_, i) => (
                        <th key={i} className="app-col-num">Column {i + 1}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* General Requirements */}
                    <tr>
                      <td colSpan={12} className="app-sheet-cat-row">General Requirements</td>
                    </tr>
                    {renderTableRows(generalItems)}

                    {/* Miscellaneous Items */}
                    <tr>
                      <td colSpan={12} className="app-sheet-cat-row">
                        Miscellaneous Items (for Direct Acquisition only) Sec 32.2 of RA No. 12009
                      </td>
                    </tr>
                    {renderTableRows(miscItems)}

                    {/* Common Supplies and Equipment */}
                    <tr>
                      <td colSpan={12} className="app-sheet-cat-row">Common Supplies and Equipment (CSE)</td>
                    </tr>
                    {renderTableRows(cseItems)}

                    {/* Total Budget Row */}
                    <tr className="app-sheet-total-row">
                      <td colSpan={9} className="app-sheet-total-label">TOTAL BUDGET:</td>
                      <td className="app-sheet-total-amount">
                        ₱{totalCalculatedBudget.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td></td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Signatures Block matching image_db4b3df3.png */}
              <div className="app-sheet-signatures">
                <div className="app-sheet-sign-col">
                  <div className="app-sheet-sign-role">Prepared by / Submitted by:</div>
                  <div className="app-sheet-sign-line"></div>
                  <div className="app-sheet-sign-name">{appRecord.submitted_by?.name || 'SUPPLY OFFICER II'}</div>
                </div>

                <div className="app-sheet-sign-col">
                  <div className="app-sheet-sign-role" style={{ textAlign: 'center' }}>Endorsed by:</div>
                  <div className="app-sheet-sign-line"></div>
                  <div className="app-sheet-sign-name">{appRecord.ard_approved_by?.name || 'ASSISTANT REGIONAL DIRECTOR'}</div>
                </div>

                <div className="app-sheet-sign-col">
                  <div className="app-sheet-sign-role" style={{ textAlign: 'right' }}>Approved by:</div>
                  <div className="app-sheet-sign-line"></div>
                  <div className="app-sheet-sign-name">{appRecord.approved_by?.name || 'REGIONAL DIRECTOR'}</div>
                </div>
              </div>
            </div>
          ) : (
            blobUrl ? (
              <iframe src={`${blobUrl}#view=FitH`} className="app-preview-frame" title="APP PDF Preview" />
            ) : (
              <p>Loading APP preview...</p>
            )
          )}
        </div>

        <div className="app-preview-actions">
          <button type="button" className="app-preview-btn is-secondary" onClick={onClose}>Close</button>

          <span className="app-preview-spacer"></span>

          {/* Export standard 12-column Excel matching image_db4b3df3.png */}
          <button
            type="button"
            className="app-preview-btn is-excel"
            onClick={() => exportStandardAppExcel(fiscalYear, { session: user, notify: showToast })}
            title="Download Standard 12-column DBM APP Excel"
          >
            📊 Export APP (.xlsx)
          </button>

          {/* Export PhilGEPS Excel matching image_600356c6.png */}
          <button
            type="button"
            className="app-preview-btn is-philgeps"
            onClick={() => exportPhilGepsAppExcel(fiscalYear, { session: user, notify: showToast })}
            title="Download PhilGEPS government submission template Excel"
          >
            📋 Export PhilGEPS APP (.xlsx)
          </button>

          {/* PDF Download */}
          <button
            type="button"
            className="app-preview-btn"
            onClick={() => generateAPP_PDF(fiscalYear)}
            title="Download 12-column PDF format"
          >
            ⬇️ Download PDF
          </button>

          {['SUP', 'ARD', 'RD'].includes(user?.role) && (
            <button
              type="button"
              className="app-preview-btn"
              onClick={() => setShowDtmsTestConfirm(true)}
              disabled={dtmsTesting}
              title="Send a test copy to DTMS using the configured reviewer addresses"
            >
              {dtmsTesting ? 'Sending test…' : 'Test DTMS Send'}
            </button>
          )}

          {user?.role === 'SUP' && appRecord.status === 'Draft' && (
            <button type="button" className="app-preview-btn" onClick={submitApp}>
              Submit APP for Review &rarr;
            </button>
          )}

          {((user?.role === 'ARD' && appRecord.currentApproverRole === 'ARD') || (user?.role === 'RD' && appRecord.currentApproverRole === 'RD')) && (
            <button type="button" className="app-preview-btn" onClick={() => setShowReviewDialog(true)}>
              Review & Decide &rarr;
            </button>
          )}
        </div>
      </div>

      {showDtmsTestConfirm && (
        <div className="logout-overlay show">
          <div className="logout-modal" role="alertdialog" aria-modal="true">
            <h3>Send an APP test copy to DTMS?</h3>
            <p>This creates a real document in the configured DTMS environment and may notify the configured ARD and RD reviewer accounts. The title will be marked [TEST]. It will not change this APP's local status or tracking information.</p>
            <div className="logout-actions">
              <button type="button" className="logout-cancel-btn" onClick={() => setShowDtmsTestConfirm(false)}>Cancel</button>
              <button type="button" className="logout-confirm-btn is-approve" onClick={handleDtmsTest}>Send test copy</button>
            </div>
          </div>
        </div>
      )}

      {showReviewDialog && (
        <div className="logout-overlay show">
          <div className="logout-modal review-modal">
            <h3>Review APP FY {fiscalYear}</h3>
            <p>{user.role === 'ARD' ? 'Endorse to Regional Director or Reject.' : 'Grant Final Approval or Reject.'}</p>
            <div className="review-field">
              <label>Remarks</label>
              <textarea value={remarks} onChange={e => { setRemarks(e.target.value); setReviewError(''); }} placeholder="Enter remarks..." />
              {reviewError && <p className="review-error" style={{ display: 'block' }}>{reviewError}</p>}
            </div>
            <div className="review-actions">
              <button type="button" className="logout-cancel-btn" onClick={() => setShowReviewDialog(false)}>Cancel</button>
              <button type="button" className="logout-confirm-btn is-reject" onClick={() => handleAction('reject')}>Reject</button>
              <button type="button" className="logout-confirm-btn is-approve" onClick={() => handleAction('approve')}>Approve</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}