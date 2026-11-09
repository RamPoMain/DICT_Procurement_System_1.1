import React, { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from '../components/layout/Sidebar.jsx';
import RequestModal from '../components/modals/RequestModal.jsx';
import AppPreviewModal from '../components/modals/AppPreviewModal.jsx';
import ExcelPreviewModal from '../components/modals/ExcelPreviewModal.jsx';
import BulkImportModal from '../components/modals/BulkImportModal.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import {
  formatPeso,
  calculateDeduplicatedBudget,
  getAllAppRecords,
  getAppRecord,
  getLatestApprovedPpmpPerOffice,
  getRecordItems,
  pruneOrphanAppRecords,
  isLatestApprovedCarryoverSource
} from '../utils/procurementRules';
import {
  readRecords,
  getPpmpStatus,
  canDeleteRecord,
  getVisibleRecords,
  canActOnRecord,
  formatRelativeTime,
  activityNote,
  getAppBadge,
  isAppPendingForUser
} from '../utils/dashboardHelpers';
import { deleteRecordById } from '../utils/entriesHelpers.js';
import { generateAPP_PDF } from '../utils/pdfGenerator';
import { exportStandardAppExcel, exportPhilGepsAppExcel, exportAppTemplateExcel, EXPORT_ROLES } from '../utils/appTemplateExport';

const iconStyle = { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 2 };

function ActivityIcon({ status }) {
  const done = status === 'Completed';
  return (
    <span className={`db-activity-icon ${done ? 'is-completed' : 'is-pending'}`}>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
        {done ? (
          <path d="M8.5 12.2 L11 14.8 L15.5 9.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M12 7.5V12L15 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        )}
      </svg>
    </span>
  );
}

export default function Dashboard() {
  const { user, isAppAuthorized } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [records, setRecords] = useState([]);
  const [apps, setApps] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState(null);
  const [appModalYear, setAppModalYear] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [previewRecordId, setPreviewRecordId] = useState(null);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkHeader, setBulkHeader] = useState(null); // form values handed over from the request form
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  const showToast = useCallback((message) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3200);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const loadData = useCallback(() => {
    if (!user) return;
    // Clear any saved APP whose approved PPMPs are gone (also heals data left over from before this check existed)
    pruneOrphanAppRecords();
    const all = readRecords();
    setRecords(getVisibleRecords(all, user));

    // APPs: saved APP records + any fiscal year that has an approved PPMP but no APP saved yet
    const appMap = new Map();
    getAllAppRecords().forEach((a) => appMap.set(String(a.fiscal_year), a));
    const approvedYears = [
      ...new Set(
        all
          .filter((r) => r && r.status === 'Completed' && /^\d{4}$/.test(String(r.fiscal_year).trim()))
          .map((r) => String(r.fiscal_year).trim())
      )
    ];
    approvedYears.forEach((y) => {
      if (!appMap.has(y)) appMap.set(y, getAppRecord(y));
    });
    setApps(Array.from(appMap.values()).sort((a, b) => Number(b.fiscal_year) - Number(a.fiscal_year)));
  }, [user]);

  useEffect(() => { loadData(); }, [loadData]);

  // Pages used to hand off to the dashboard through sessionStorage
  // (e.g. "open this record", "open a new request"). Same behavior here.
  useEffect(() => {
    if (!user) return;
    const openRecordId = sessionStorage.getItem('open_record_id');
    const openNew = sessionStorage.getItem('open_new_request') === '1';
    if (openRecordId) {
      sessionStorage.removeItem('open_record_id');
      setSelectedRecordId(openRecordId);
      setModalOpen(true);
    } else if (openNew && user.canRequest) {
      sessionStorage.removeItem('open_new_request');
      setSelectedRecordId(null);
      setModalOpen(true);
    }
  }, [user]);

  const openNewRequest = () => { setSelectedRecordId(null); setModalOpen(true); };
  const openRecord = (id) => { setSelectedRecordId(id); setModalOpen(true); };
  const closePreview = useCallback(() => setPreviewRecordId(null), []);
  const openFullFromPreview = (id) => { setPreviewRecordId(null); openRecord(id); };

  // ---- Delete (with confirmation) ----
  const requestDelete = (record) => {
    if (isLatestApprovedCarryoverSource(record, readRecords())) {
      showToast(`PPMP No. ${record.ppmp_no} for FY ${record.fiscal_year} is the latest approved plan and must remain available for carryover.`);
      return;
    }
    if (!canDeleteRecord(record, user)) {
      showToast('An approved PPMP is closed and can only be deleted by an approver.');
      return;
    }
    setPendingDeleteId(record.id);
  };

  const confirmDelete = () => {
    const before = readRecords();
    const target = before.find((r) => r.id === pendingDeleteId);
    setPendingDeleteId(null);
    if (!target || isLatestApprovedCarryoverSource(target, before)) {
      showToast(target
        ? `PPMP No. ${target.ppmp_no} for FY ${target.fiscal_year} is the latest approved plan and must remain available for carryover.`
        : 'Could not find the request to delete.');
      return;
    }
    if (!deleteRecordById(pendingDeleteId)) {
      showToast('Could not delete the request.');
      return;
    }

    // Deleting the last approved PPMP of a year also resets that year's APP, so FY stays consistent.
    const resetYears = target?.status === 'Completed' ? pruneOrphanAppRecords() : [];
    loadData();
    showToast(
      resetYears.length
        ? `Request deleted. The APP for FY ${resetYears.join(', ')} was reset because no approved PPMPs remain.`
        : 'Request deleted successfully.'
    );
  };

  // ---- Stats ----
  const isSupplier = user?.role === 'SUP';

  const appBudget = (year) =>
    getLatestApprovedPpmpPerOffice(records, year)
      .reduce((sum, r) => sum + calculateDeduplicatedBudget(getRecordItems(r)), 0);

  const totalRequests = isSupplier ? apps.length : records.length;
  const pendingRequests = isSupplier
    ? apps.filter((a) => a.status !== 'Completed').length
    : records.filter((r) => getPpmpStatus(r) !== 'Completed').length;
  const completedRequests = isSupplier
    ? apps.filter((a) => a.status === 'Completed').length
    : records.filter((r) => r.status === 'Completed').length;
  const totalBudget = isSupplier
    ? apps.reduce((s, a) => s + appBudget(a.fiscal_year), 0)
    : records.reduce((s, r) => s + calculateDeduplicatedBudget(getRecordItems(r)), 0);

  // ---- Notification dot: something is waiting on this account ----
  const hasPendingApprovals =
    records.some((r) => canActOnRecord(r, user)) || isAppPendingForUser(getAllAppRecords(), user);

  const canExportExcel = !!user && EXPORT_ROLES.includes(user.role);
  const secondaryBtnStyle = { padding: '7px 16px', fontSize: 12.5, fontWeight: 600, width: 'auto', height: 'auto' };
  const accentBtnStyle = { ...secondaryBtnStyle, background: 'var(--db-accent)', color: '#fff', borderColor: 'var(--db-accent)' };

  const recent = [...records].sort((a, b) => b.id - a.id).slice(0, 6);

  const reviewButton = (app) => {
    const myTurn =
      app.status === 'For Approval' &&
      ((user?.role === 'ARD' && app.currentApproverRole === 'ARD') ||
        (user?.role === 'RD' && app.currentApproverRole === 'RD'));
    return myTurn ? (
      <button
        type="button"
        className="db-action-btn"
        style={{ padding: '7px 16px', fontSize: 12.5, fontWeight: 600, width: 'auto', height: 'auto', background: 'var(--db-accent)', color: '#fff', borderColor: 'var(--db-accent)' }}
        onClick={() => setAppModalYear(app.fiscal_year)}
      >
        Review ({user.role}) &rarr;
      </button>
    ) : (
      <button
        type="button"
        className="db-action-btn"
        style={{ padding: '7px 16px', fontSize: 12.5, fontWeight: 600, width: 'auto', height: 'auto' }}
        onClick={() => setAppModalYear(app.fiscal_year)}
      >
        View APP
      </button>
    );
  };

  return (
    <div className="db-body">
      <Sidebar onNewRequest={openNewRequest} hasPendingApprovals={hasPendingApprovals} />

      <main className="db-main">
        <div className="db-header-banner">
          <img src="/images/header-banner.png" alt="DICT Banner" />
        </div>

        <div className="db-topbar">
          <div>
            <h1 className="db-title">Procurement Dashboard</h1>
            <p className="db-subtitle">Welcome back, {user?.roleName}</p>
          </div>
          <div className="db-topbar-actions">
            <button type="button" className="db-icon-btn" onClick={toggleTheme} title="Toggle theme">
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </div>

        {/* Welcome card with New Request button (requesters only) */}
        <div className="db-welcome-card">
          <div>
            <h2>Good day, {user?.roleName}!</h2>
            <p>Here's a quick look at your procurement requests and activity.</p>
          </div>
          {user?.canRequest && (
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button type="button" className="db-new-request-btn" onClick={openNewRequest}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New Request
              </button>
              <button
                type="button"
                className="db-new-request-btn"
                style={{
                  background: 'rgba(59, 130, 246, 0.12)',
                  color: 'var(--db-accent, #3b82f6)',
                  border: '1px solid var(--db-accent, #3b82f6)'
                }}
                onClick={() => { setBulkHeader(null); setBulkModalOpen(true); }}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15V4m0 0L8 8m4-4l4 4M5 20h14" />
                </svg>
                Bulk Import
              </button>
            </div>
          )}
        </div>

        {/* Stats Grid */}
        <div className="db-stats-grid">
          <div className="db-stat-card db-stat-blue">
            <div className="db-stat-head">
              <span className="db-stat-label">{isSupplier ? 'Total APP Versions' : 'Total PPMP Versions'}</span>
            </div>
            <p className="db-stat-value">{totalRequests}</p>
          </div>
          <div className="db-stat-card db-stat-amber">
            <div className="db-stat-head"><span className="db-stat-label">Pending / In Review</span></div>
            <p className="db-stat-value">{pendingRequests}</p>
          </div>
          <div className="db-stat-card db-stat-green">
            <div className="db-stat-head"><span className="db-stat-label">Fully Approved</span></div>
            <p className="db-stat-value">{completedRequests}</p>
          </div>
          <div className="db-stat-card db-stat-violet">
            <div className="db-stat-head">
              <span className="db-stat-label">{isSupplier ? 'Total APP Budget' : 'Total Estimated Budget'}</span>
            </div>
            <p className="db-stat-value">{formatPeso(totalBudget)}</p>
          </div>
        </div>

        {/* APP section for SUP, ARD and RD */}
        {isAppAuthorized && (
          <div className="db-activity-card" style={{ marginBottom: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>Annual Procurement Plans (APP)</h3>
              {apps.length > 0 && (
                <span style={{ fontSize: 12, color: 'var(--db-text-faint)' }}>{apps.length} plan(s) recorded</span>
              )}
            </div>

            {apps.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--db-text-dim)' }}>
                No Annual Procurement Plans compiled yet. Approved PPMPs will assemble here.
              </p>
            ) : (
              apps.map((app) => {
                const badge = getAppBadge(app);
                return (
                  <div
                    key={app.fiscal_year}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderTop: '1px solid var(--db-border)' }}
                  >
                    <div>
                      <strong style={{ fontSize: 13.5, display: 'block', marginBottom: 3 }}>
                        Annual Procurement Plan for FY {app.fiscal_year}
                      </strong>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: 'var(--db-text-dim)' }}>
                        <span>Budget: <strong>{formatPeso(appBudget(app.fiscal_year))}</strong></span>
                        <span>&bull;</span>
                        <span className={`db-status-pill ${badge.className}`}>{badge.label}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {reviewButton(app)}
                      {app.status === 'Completed' && (
                        <button
                          type="button"
                          className="db-action-btn"
                          title="Download PDF"
                          style={accentBtnStyle}
                          onClick={() => generateAPP_PDF(String(app.fiscal_year), { session: user, notify: showToast })}
                        >
                          Download PDF
                        </button>
                      )}
                      {canExportExcel && (
                        <>
                          <button
                            type="button"
                            className="db-action-btn"
                            title="Export Standard 12-Column APP (Excel)"
                            style={{ ...secondaryBtnStyle, background: '#15803d', color: '#fff', borderColor: '#15803d' }}
                            onClick={() => exportStandardAppExcel(String(app.fiscal_year), { session: user, notify: showToast })}
                          >
                            Export APP (.xlsx)
                          </button>
                          <button
                            type="button"
                            className="db-action-btn"
                            title="Export PhilGEPS APP template (Excel)"
                            style={{ ...secondaryBtnStyle, background: '#0284c7', color: '#fff', borderColor: '#0284c7' }}
                            onClick={() => exportPhilGepsAppExcel(String(app.fiscal_year), { session: user, notify: showToast })}
                          >
                            Export PhilGEPS (.xlsx)
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Recent Activity */}
        <div className="db-activity-card">
          <h3>Recent Procurement Activity</h3>
          <ul className="db-activity-list">
            {recent.length === 0 ? (
              <li className="db-activity-empty">No activity yet.</li>
            ) : (
              recent.map((r) => {
                const label = `PPMP No. ${r.ppmp_no} — ${r.end_user || 'N/A'}`;
                return (
                  <li key={r.id} className="db-activity-item">
                    <div className="db-activity-main">
                      <ActivityIcon status={getPpmpStatus(r)} />
                      <div>
                        <p className="db-activity-text" title={label}>{label}</p>
                        <span className="db-activity-time">
                          {formatRelativeTime(r.id)}{activityNote(r)}
                        </span>
                      </div>
                    </div>

                    <div className="db-activity-actions">
                      <button type="button" className="db-action-btn" title="Preview Excel Format" onClick={() => setPreviewRecordId(r.id)}>
                        <svg {...iconStyle}>
                          <path d="M4 5.5C4 4.7 4.7 4 5.5 4H18.5C19.3 4 20 4.7 20 5.5V18.5C20 19.3 19.3 20 18.5 20H5.5C4.7 20 4 19.3 4 18.5V5.5Z" />
                          <path d="M4 9H20M4 14H20M9 4V20M15 4V20" />
                        </svg>
                      </button>
                      <button type="button" className="db-action-btn" title="View Details" onClick={() => openRecord(r.id)}>
                        <svg {...iconStyle}>
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      </button>
                      {canDeleteRecord(r, user) && (
                        <button type="button" className="db-action-btn delete" title="Delete" onClick={() => requestDelete(r)}>
                          <svg {...iconStyle}>
                            <path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </main>

      <RequestModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        recordId={selectedRecordId}
        onSaved={loadData}
        onBulkImport={(formHeader) => {
          setBulkHeader(formHeader || null);
          setModalOpen(false);
          setBulkModalOpen(true);
        }}
      />
      <BulkImportModal
        isOpen={bulkModalOpen}
        onClose={() => setBulkModalOpen(false)}
        headerData={bulkHeader}
        onSuccess={(res) => {
          loadData();
          const itemWord = res.count === 1 ? 'item' : 'items';
          const where =
            res.mode === 'append' ? `added to Draft PPMP No. ${res.ppmp_no}`
            : res.mode === 'new-version' ? `imported into new PPMP No. ${res.ppmp_no} (${res.carried} carried over from No. ${res.carried_from})`
            : `imported under PPMP No. ${res.ppmp_no}`;
          showToast(`${res.count} ${itemWord} ${where}.` +
            (res.converted ? ` ${res.converted} switched to Two Failed Biddings.` : '') +
            ' Attach the supporting documents before submitting.');
        }}
      />
      {appModalYear && (
        <AppPreviewModal isOpen={!!appModalYear} onClose={() => setAppModalYear(null)} fiscalYear={appModalYear} onUpdated={loadData} />
      )}

      <ExcelPreviewModal
        record={records.find((r) => r.id === previewRecordId) || null}
        onClose={closePreview}
        onOpenRequest={openFullFromPreview}
        notify={showToast}
      />

      {/* Delete confirmation */}
      {pendingDeleteId !== null && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setPendingDeleteId(null)}
        >
          <div
            style={{ background: 'var(--db-card)', border: '1px solid var(--db-border)', borderRadius: 'var(--db-radius)', padding: 24, maxWidth: 400, width: '90%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0 }}>Delete Request?</h3>
            <p style={{ fontSize: 13.5, color: 'var(--db-text-dim)' }}>
              Are you sure you want to delete this procurement request? This action cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="db-action-btn" style={{ width: 'auto', height: 'auto', padding: '7px 16px' }} onClick={() => setPendingDeleteId(null)}>
                Cancel
              </button>
              <button type="button" className="db-action-btn delete" style={{ width: 'auto', height: 'auto', padding: '7px 16px' }} onClick={confirmDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`db-toast${toast ? ' show' : ''}`}>{toast}</div>
    </div>
  );
}