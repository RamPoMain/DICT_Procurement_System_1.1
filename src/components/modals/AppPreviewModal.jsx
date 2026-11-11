import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  getAppRecord,
  saveAppRecord,
  getLatestApprovedPpmpPerOffice,
  getRecordItems,
  parseBudgetNumber,
  calculateDeduplicatedBudget,
  formatApprovalDateTime
} from '../../utils/procurementRules.js';
import { previewAPP_PDF, generateAPP_PDF, formatMonthYear } from '../../utils/pdfGenerator.js';
import { exportStandardAppExcel, exportPhilGepsAppExcel } from '../../utils/appTemplateExport.js';
import { APP_CHAIN, downloadSignedDtmsFile, submitAppViaDtms, submitAppStageToDtms, syncAllWithDtms, testSendToDtms } from '../../utils/dtmsClient.js';
import { canActOnApp } from '../../utils/dashboardHelpers.js';
import FileStore from '../../utils/fileStore.js';

const signingStageLabel = (rec) => stageLabel(rec.dtms_signing_stage || rec.currentApproverRole);
const stageLabel = (role) => APP_CHAIN.find((step) => step.role === role)?.label || role || 'Approver';

export default function AppPreviewModal({ isOpen, onClose, fiscalYear, onUpdated }) {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('sheet'); // 'sheet' | 'pdf'
  const [blobUrl, setBlobUrl] = useState(null);
  const [signedPdfUrl, setSignedPdfUrl] = useState(null);
  const [appRecord, setAppRecord] = useState(null);
  const [allItems, setAllItems] = useState([]);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [exportNotice, setExportNotice] = useState('');
  const [showDtmsTestConfirm, setShowDtmsTestConfirm] = useState(false);
  const [dtmsTesting, setDtmsTesting] = useState(false);
  const [showDtmsSubmitConfirm, setShowDtmsSubmitConfirm] = useState(false);
  const [dtmsSubmitting, setDtmsSubmitting] = useState(false);
  const [stageSubmitting, setStageSubmitting] = useState(false);

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

  useEffect(() => {
    if (!isOpen || !fiscalYear) return undefined;
    const timer = setInterval(() => setAppRecord(getAppRecord(fiscalYear)), 5000);
    return () => clearInterval(timer);
  }, [isOpen, fiscalYear]);

  // Pull DTMS results (signatures / rejections) in while the APP is open, so a signature that has
  // just been applied shows up here without reopening the modal.
  useEffect(() => {
    if (!isOpen || !fiscalYear) return undefined;
    let active = true;
    const sync = async () => {
      try {
        if (await syncAllWithDtms() && active) {
          setAppRecord(getAppRecord(fiscalYear));
          if (onUpdated) onUpdated();
        }
      } catch (e) {
        if (active) showToast(`DTMS sync issue: ${e.message}`);
      }
    };
    const syncWhenVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    sync();
    const timer = setInterval(sync, 45000);
    document.addEventListener('visibilitychange', syncWhenVisible);
    window.addEventListener('focus', syncWhenVisible);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', syncWhenVisible);
      window.removeEventListener('focus', syncWhenVisible);
    };
  }, [isOpen, fiscalYear]);

  useEffect(() => {
    if (!isOpen || !appRecord?.dtms_signed_file_id) {
      setSignedPdfUrl(null);
      return undefined;
    }

    let active = true;
    let url;
    FileStore.get(appRecord.dtms_signed_file_id).then((blob) => {
      if (!active) return;
      if (!blob) {
        showToast('Signed APP PDF is missing from this browser’s file storage.');
        return;
      }
      url = URL.createObjectURL(blob);
      setSignedPdfUrl(url);
    }).catch((error) => {
      if (active) showToast(`Could not load signed APP PDF: ${error.message}`);
    });

    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [isOpen, appRecord?.dtms_signed_file_id]);

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

  // --- DTMS signing state, shown in the banner / review dialog / signature block ---
  const canAct = canActOnApp(appRecord, user);
  const inDtmsFlow = appRecord.status === 'For Approval' && !!appRecord.dtms_track;
  const waitingInDtms = inDtmsFlow && !appRecord.dtms_signing_complete;
  const fetchingSigned = inDtmsFlow && !!appRecord.dtms_signing_complete && appRecord.dtms_signed_file_track !== appRecord.dtms_track;
  const signedReady = inDtmsFlow && !!appRecord.dtms_signing_complete && appRecord.dtms_signed_file_track === appRecord.dtms_track;
  const signatures = appRecord.signatures || {};
  const signedSubmission = (appRecord.dtms_submissions || []).find((sub) => sub.signed_file_id && sub.signed_file_id === appRecord.dtms_signed_file_id);
  const signatureSummary = APP_CHAIN
    .filter((step) => signatures[step.role])
    .map((step) => `${step.label}: ${signatures[step.role].name}${signatures[step.role].signed_at ? ` (${new Date(signatures[step.role].signed_at).toLocaleDateString()})` : ''}`)
    .join(' · ');
  const signedLine = (sig, verb = 'Digitally signed') => (sig?.signed_at
    ? <div style={{ fontSize: 10, textAlign: 'center', color: '#166534', marginTop: 2 }}>✓ {verb} {new Date(sig.signed_at).toLocaleDateString()}</div>
    : null);

  const closeReview = () => {
    setShowReviewDialog(false);
    setRemarks('');
    setReviewError('');
  };

  const handleAction = async (action) => {
    if (stageSubmitting) return;
    const trimmed = remarks.trim();
    if (action !== 'approve' && !trimmed) {
      setReviewError('Remarks are required to reject or add remarks.');
      return;
    }

    // Re-read the saved APP: a DTMS sync may have changed it since this modal rendered.
    const current = getAppRecord(fiscalYear);
    if (!canActOnApp(current, user)) {
      setAppRecord(current);
      closeReview();
      showToast('This APP is not waiting for your decision yet (its DTMS-signed copy may not have returned).');
      return;
    }

    // ARD / RD approve -> the signed copy goes to DTMS for their own signature (same as TOD / Budget Officer on a PPMP).
    if (action === 'approve' && ['ARD', 'RD'].includes(user.role) && current.dtms_track) {
      setStageSubmitting(true);
      try {
        const result = await submitAppStageToDtms(fiscalYear, user, trimmed);
        if (!result.success) {
          showToast(result.error);
          return;
        }
        closeReview();
        setAppRecord({ ...result.record });
        showToast(result.message);
        if (onUpdated) onUpdated();
      } catch (e) {
        showToast(`Could not send this APP to DTMS: ${e.message}`);
      } finally {
        setStageSubmitting(false);
      }
      return;
    }

    const updated = { ...current, remarksHistory: [...(Array.isArray(current.remarksHistory) ? current.remarksHistory : [])] };
    updated.remarksHistory.push({
      stage: user.role,
      role: user.role,
      name: user.roleName,
      action: action === 'approve' ? 'approved' : (action === 'reject' ? 'rejected' : 'remark'),
      remarks: trimmed || 'Approved.',
      round: Number(current.submission_round) || 1,
      date: new Date().toLocaleDateString(),
      at: Date.now()
    });

    let message = `Remark added to APP FY ${fiscalYear}.`;
    if (action === 'reject') {
      updated.status = 'Draft';
      updated.currentApproverRole = null;
      updated.returned_for_revision = true;
      updated.rejected_by = { name: user.roleName, role: user.role, email: user.email, stage: user.role };
      updated.rejected_at = Date.now();
      if (current.dtms_track) {
        updated.dtms_rejected_track = current.dtms_track;
        updated.dtms_track = null;
        updated.dtms_signing_complete = false;
      }
      message = `APP FY ${fiscalYear} rejected and returned to Supply.`;
    } else if (action === 'approve') {
      if (user.role === 'ARD') {
        // Older APPs that never went through DTMS: forward locally.
        updated.currentApproverRole = 'RD';
        updated.ard_approved_by = { name: user.roleName, role: user.role };
        updated.ard_approved_at = Date.now();
        message = `APP FY ${fiscalYear} endorsed and forwarded to the Regional Director.`;
      } else if (user.role === 'RD') {
        // Final step: RD approves the DTMS-signed copy in the system.
        updated.status = 'Completed';
        updated.currentApproverRole = 'None';
        updated.returned_for_revision = false;
        updated.approved_by = { name: user.roleName, role: user.role, email: user.email };
        updated.approved_at = Date.now();
        message = `APP FY ${fiscalYear} approved and marked Final.`;
      }
    }

    try {
      saveAppRecord(updated);
    } catch {
      showToast('Could not save your decision. Please try again.');
      return;
    }
    setAppRecord(updated);
    closeReview();
    showToast(message);
    if (onUpdated) onUpdated();
  };

  const submitApp = async () => {
    if (dtmsSubmitting) return;
    setShowDtmsSubmitConfirm(false);
    setDtmsSubmitting(true);
    try {
      const result = await submitAppViaDtms(fiscalYear, user);
      if (!result.success) throw new Error(result.error);
      setAppRecord(result.record);
      showToast(result.message || `APP sent to DTMS for signing. Tracking no. ${result.tracknumber}`);
      if (onUpdated) onUpdated();
    } catch (e) {
      showToast(`APP DTMS submission failed: ${e.message}`);
    } finally {
      setDtmsSubmitting(false);
    }
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
                {signedPdfUrl ? '📄 Signed PDF' : '📄 PDF Preview'}
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

        {inDtmsFlow && (
          <div style={{
            padding: '7px 12px', fontSize: 12, fontWeight: 600,
            background: signedReady ? '#dcfce7' : '#fef3c7',
            color: signedReady ? '#166534' : '#92400e'
          }}>
            {waitingInDtms && `Waiting for the ${signingStageLabel(appRecord)} digital signature in DTMS · Tracking no. ${appRecord.dtms_track}`}
            {fetchingSigned && 'Signed in DTMS. Retrieving the signed copy…'}
            {signedReady && `Signed copy received from DTMS${signatureSummary ? ` (${signatureSummary})` : ''}. ${canAct ? 'Ready for your review.' : `Waiting for ${stageLabel(appRecord.currentApproverRole)} to review.`}`}
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
                  <div className="app-sheet-sign-name">{signatures.SUP?.name || appRecord.submitted_by?.name || 'SUPPLY OFFICER II'}</div>
                  {signedLine(signatures.SUP)}
                </div>

                <div className="app-sheet-sign-col">
                  <div className="app-sheet-sign-role" style={{ textAlign: 'center' }}>Endorsed by:</div>
                  <div className="app-sheet-sign-line"></div>
                  <div className="app-sheet-sign-name">{signatures.ARD?.name || appRecord.ard_approved_by?.name || 'ASSISTANT REGIONAL DIRECTOR'}</div>
                  {signedLine(signatures.ARD)}
                </div>

                <div className="app-sheet-sign-col">
                  <div className="app-sheet-sign-role" style={{ textAlign: 'right' }}>Approved by:</div>
                  <div className="app-sheet-sign-line"></div>
                  <div className="app-sheet-sign-name">{signatures.RD?.name || appRecord.approved_by?.name || 'REGIONAL DIRECTOR'}</div>
                  {signedLine(signatures.RD || (isFinal ? { signed_at: appRecord.approved_at } : null), signatures.RD ? 'Digitally signed' : 'Approved')}
                </div>
              </div>
            </div>
          ) : (
            (signedPdfUrl || blobUrl) ? (
              <>
                {signedPdfUrl && (
                  <div style={{ padding: '7px 12px', color: '#166534', background: '#dcfce7', fontSize: 12, fontWeight: 600 }}>
                    DTMS-signed APP{signedSubmission ? ` · ${stageLabel(signedSubmission.stage)} signature` : ''} · Tracking no. {signedSubmission?.tracknumber || appRecord.dtms_track}
                  </div>
                )}
                <iframe
                  src={`${signedPdfUrl || blobUrl}#view=FitH`}
                  className="app-preview-frame"
                  title={signedPdfUrl ? 'DTMS-signed APP PDF' : 'APP PDF Preview'}
                />
              </>
            ) : (
              <p>Loading APP preview...</p>
            )
          )}
        </div>

        {Array.isArray(appRecord.remarksHistory) && appRecord.remarksHistory.length > 0 && (
          <details className="review-remarks" style={{ margin: '8px 16px' }}>
            <summary className="review-history-title" style={{ cursor: 'pointer' }}>
              Review history ({appRecord.remarksHistory.length})
            </summary>
            <ul className="review-list" style={{ maxHeight: 180, overflowY: 'auto' }}>
              {appRecord.remarksHistory.map((h, idx) => {
                const action = h.action || 'approved';
                return (
                  <li key={idx} className="review-item">
                    <div className="review-item-head">
                      <span className={`review-tag is-${action}`}>
                        {action === 'approved' ? (h.role === 'DTMS' ? 'Signed' : 'Approved') : action === 'rejected' ? 'Rejected' : action === 'remark' ? 'Remark' : 'Submitted'}
                      </span>
                      <strong>{h.name || h.role || 'Approver'}</strong>
                      <span>{[stageLabel(h.stage), formatApprovalDateTime(h.at) || h.date].filter(Boolean).join(' \u00b7 ')}</span>
                    </div>
                    {h.remarks && <p className="review-item-text">{h.remarks}</p>}
                  </li>
                );
              })}
            </ul>
          </details>
        )}

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
              title="Send a test copy to DTMS using the configured signer addresses"
            >
              {dtmsTesting ? 'Sending test…' : 'Test DTMS Send'}
            </button>
          )}

          {appRecord.dtms_signed_file_id && (
            <button
              type="button"
              className="app-preview-btn"
              onClick={() => downloadSignedDtmsFile(appRecord).catch((e) => showToast(e.message))}
            >
              Download signed DTMS PDF
            </button>
          )}

          {user?.role === 'SUP' && appRecord.status === 'Draft' && (
            <button type="button" className="app-preview-btn" onClick={() => setShowDtmsSubmitConfirm(true)} disabled={dtmsSubmitting}>
              {dtmsSubmitting ? 'Sending to DTMS…' : 'Submit APP for signing →'}
            </button>
          )}

          {canAct && (
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
            <p>This creates a real test document in DTMS and may notify the configured signing accounts. The title will be marked [TEST]. It will not change this APP's local status or tracking information.</p>
            <div className="logout-actions">
              <button type="button" className="logout-cancel-btn" onClick={() => setShowDtmsTestConfirm(false)}>Cancel</button>
              <button type="button" className="logout-confirm-btn is-approve" onClick={handleDtmsTest}>Send test copy</button>
            </div>
          </div>
        </div>
      )}

      {showDtmsSubmitConfirm && (
        <div className="logout-overlay show">
          <div className="logout-modal" role="alertdialog" aria-modal="true">
            <h3>Submit APP FY {fiscalYear} to DTMS?</h3>
            <p>This sends the APP PDF to DTMS for Supply's digital signature. After signing, it returns to the Procurement System for the ARD's review. The ARD then signs in DTMS, and the Regional Director reviews and signs the same way before the APP becomes Final. It creates a real DTMS document and locks this APP while it is being signed.</p>
            <div className="logout-actions">
              <button type="button" className="logout-cancel-btn" onClick={() => setShowDtmsSubmitConfirm(false)}>Cancel</button>
              <button type="button" className="logout-confirm-btn is-approve" onClick={submitApp} disabled={dtmsSubmitting}>
                {dtmsSubmitting ? 'Sending…' : 'Submit to DTMS'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReviewDialog && (
        <div className="logout-overlay show" style={{ zIndex: 3000 }}>
          <div
            className="logout-modal review-modal"
            role="dialog"
            aria-modal="true"
            style={{ width: 'min(1180px, 96vw)', maxWidth: '96vw', height: 'min(94vh, 900px)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}
          >
            <h3>Review APP FY {fiscalYear}</h3>
            <p>
              {(['ARD', 'RD'].includes(user.role) && appRecord.dtms_track
                ? (user.role === 'ARD'
                  ? 'Approve to send it to DTMS for your digital signature. After signing, it returns to the Procurement System for the Regional Director. '
                  : 'Approve to send it to DTMS for your digital signature. Once signed, the APP is marked Final. ')
                : user.role === 'ARD'
                  ? 'Approve to endorse it to the Regional Director. '
                  : 'Approve is the final step: it marks the APP Final and closes it. ') +
                `Reject returns it to Supply for revision (remarks required). Your decision is recorded under ${user.roleName || 'Approver'}.`}
            </p>

            {/* The DTMS-signed copy, so the reviewer sees the signature(s) that already came back. */}
            <div style={{
              flex: '1 1 0', minHeight: 240, display: 'flex', flexDirection: 'column', overflow: 'hidden',
              margin: '4px 0 16px', border: '1px solid var(--db-border, rgba(128,128,128,0.35))', borderRadius: 10
            }}>
              {signedPdfUrl ? (
                <>
                  <div style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, color: '#166534', background: '#dcfce7' }}>
                    DTMS-signed copy{signatureSummary ? ` · ${signatureSummary}` : ''}
                  </div>
                  <iframe src={`${signedPdfUrl}#view=FitH`} title="DTMS-signed APP PDF" style={{ flex: 1, width: '100%', minHeight: 0, border: 0 }} />
                </>
              ) : blobUrl ? (
                <>
                  <div style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, color: '#92400e', background: '#fef3c7' }}>
                    No DTMS-signed copy on file. Showing the generated APP instead.
                  </div>
                  <iframe src={`${blobUrl}#view=FitH`} title="APP PDF Preview" style={{ flex: 1, width: '100%', minHeight: 0, border: 0 }} />
                </>
              ) : (
                <p style={{ padding: 16 }}>Loading APP preview...</p>
              )}
            </div>

            <div className={`review-field ${reviewError ? 'has-error' : ''}`}>
              <label>Remarks / Notes (required for Reject or Remark):</label>
              <textarea
                value={remarks}
                onChange={e => { setRemarks(e.target.value); setReviewError(''); }}
                placeholder="Enter reason for rejection, conditions, or review remarks..."
              />
              {reviewError && <p className="review-error" style={{ display: 'block' }}>{reviewError}</p>}
            </div>

            <div className="review-actions">
              <button type="button" className="logout-cancel-btn" disabled={stageSubmitting} onClick={closeReview}>Cancel</button>
              <button
                type="button"
                className="db-action-btn"
                disabled={stageSubmitting}
                style={{ width: '100%', height: 'auto', padding: '10px 14px', borderRadius: 9, fontWeight: 600, fontSize: 13 }}
                onClick={() => handleAction('comment')}
              >
                Add remark only
              </button>
              <button type="button" className="logout-confirm-btn is-reject" disabled={stageSubmitting} onClick={() => handleAction('reject')}>Reject</button>
              <button type="button" className="logout-confirm-btn is-approve" disabled={stageSubmitting} onClick={() => handleAction('approve')}>
                {stageSubmitting
                  ? 'Sending to DTMS…'
                  : ['ARD', 'RD'].includes(user.role) && appRecord.dtms_track ? 'Approve & Send for Signature' : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}