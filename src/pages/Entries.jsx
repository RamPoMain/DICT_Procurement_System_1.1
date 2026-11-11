import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Sidebar from '../components/layout/Sidebar.jsx';
import RequestModal from '../components/modals/RequestModal.jsx';
import BulkImportModal from '../components/modals/BulkImportModal.jsx';
import AppPreviewModal from '../components/modals/AppPreviewModal.jsx';
import ExcelPreviewModal from '../components/modals/ExcelPreviewModal.jsx';
import PpmpExpanded from '../components/entries/PpmpExpanded.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import {
  formatPeso,
  getAllAppRecords,
  isPpmpDraft,
  formatApprovalDate,
  getItemsMissingDocuments,
  getItemsBudgetModeMismatch,
  buildMissingDocsMessage,
  buildBudgetMismatchMessage,
  isLatestApprovedCarryoverSource
} from '../utils/procurementRules.js';
import {
  readRecords,
  getVisibleRecords,
  getPpmpStatus,
  isPpmpClosed,
  isPpmpReturned,
  canDeleteRecord
} from '../utils/dashboardHelpers.js';
import {
  ENTRY_FILTER_DEFAULTS,
  filterEntryRecords,
  getApprovedEntryNumbers,
  getOffices,
  getAppButtonInfo,
  getRecordDescriptionSummary,
  getRecordProjectTypeSummary,
  getRecordTotalBudget,
  deleteRecordById
} from '../utils/entriesHelpers.js';
import { exportPPMP_Excel } from '../utils/entriesExport';
import ExportMenu from '../components/entries/ExportMenu.jsx';
import { generatePPMP_PDF } from '../utils/pdfGenerator.js';
import { syncAllWithDtms, submitPpmpViaDtms } from '../utils/dtmsClient.js';
import "../assets/styles/ppmp-inline-edit.css";

const STAGE_LABELS = { HEAD: 'Unit Head', TOD: 'TOD', BO: 'Budget Officer', RD: 'Regional Director' };
const APP_ROLES = ['SUP', 'ARD', 'RD'];

const statusClass = (status) =>
  status === 'Completed' ? 'is-completed' : status === 'For Approval' ? 'is-pending' : 'is-draft';

function StatusPill({ record, user }) {
  const status = getPpmpStatus(record);

  if (isPpmpReturned(record)) {
    const by = record.rejected_by?.name || 'an approver';
    return (
      <span className="db-status-pill is-returned" title={`Returned by ${by} - open the PPMP to read the remarks`}>
        Returned
      </span>
    );
  }

  const submittedTitle = status === 'For Approval' && record.submitted_by
    ? `Submitted by ${record.submitted_by.name}${record.submitted_at ? ' on ' + formatApprovalDate(record.submitted_at) : ''}`
    : undefined;

  let label = status;
  if (status === 'For Approval' && user?.canTrackApprovals) {
    const where = STAGE_LABELS[record.currentApproverRole];
    if (where) label = `For Approval · ${where}`;
  }
  return <span className={`db-status-pill ${statusClass(status)}`} title={submittedTitle}>{label}</span>;
}

function ApprovedByCell({ record }) {
  if (!isPpmpClosed(record)) return <span className="db-approver-none">—</span>;
  if (!record.approved_by) {
    return <span className="db-approver-none" title="This PPMP was completed before approver tracking existed">Not recorded</span>;
  }
  return (
    <div className="db-approver">
      <strong>{record.approved_by.name}</strong>
      <span>{formatApprovalDate(record.approved_at)}</span>
    </div>
  );
}

function ConfirmDialog({ dialog, onCancel, onConfirm }) {
  useEffect(() => {
    if (!dialog) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dialog, onCancel]);

  if (!dialog) return null;
  return (
    <div className="db-modal-overlay" style={{ zIndex: 2000 }}>
      <div className="db-modal" role="alertdialog" aria-modal="true" style={{ maxWidth: 400, textAlign: 'center', padding: '40px 30px' }}>
        {dialog.danger && (
          <div style={{ background: 'rgba(239, 68, 68, 0.1)', width: 60, height: 60, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
            <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#ef4444" strokeWidth="2">
              <path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
          </div>
        )}
        <h3 style={{ fontSize: 18, marginBottom: 10, color: 'var(--db-text, #E7EAF3)' }}>{dialog.title}</h3>
        <p style={{ color: 'var(--db-text-dim, #8B94A8)', fontSize: 14, marginBottom: 30, lineHeight: 1.5 }}>{dialog.text}</p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button type="button" className="back-btn" style={{ flex: 1 }} onClick={onCancel} autoFocus>Cancel</button>
          <button
            type="button"
            className="next-btn"
            style={{ flex: 1, ...(dialog.danger ? { background: '#ef4444' } : null) }}
            onClick={onConfirm}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Entries() {
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [tab, setTab] = useState(user?.role === 'SUP' ? 'app' : 'ppmp');
  const [records, setRecords] = useState([]);
  const [apps, setApps] = useState([]);
  const [filters, setFilters] = useState(ENTRY_FILTER_DEFAULTS);
  const [expandedId, setExpandedId] = useState(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [selectedRecordId, setSelectedRecordId] = useState(null);
  const [appModalYear, setAppModalYear] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkHeader, setBulkHeader] = useState(null);
  const [previewRecord, setPreviewRecord] = useState(null);
  // True while the open PPMP has unsaved inline edits (reported by PpmpExpanded).
  const dirtyRef = useRef(false);
  const dtmsSyncInFlightRef = useRef(false);
  const handleDirtyChange = useCallback((isDirty) => { dirtyRef.current = isDirty; }, []);

  const loadData = useCallback(() => {
    setRecords(getVisibleRecords(readRecords(), user));
    setApps(getAllAppRecords());
  }, [user]);

  useEffect(() => { loadData(); }, [loadData]);

  // DTMS: pull approval results (approved / rejected) into the records.
  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (dirtyRef.current || dtmsSyncInFlightRef.current) return; // don't reload while editing or already syncing
      dtmsSyncInFlightRef.current = true;
      try {
        if (await syncAllWithDtms() && alive) loadData();
      } catch (e) {
        if (alive) {
          loadData();
          setToast(`DTMS sync issue: ${e.message}`);
        }
      } finally {
        dtmsSyncInFlightRef.current = false;
      }
    };
    const syncWhenVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    run();
    const t = setInterval(run, 45000);
    document.addEventListener('visibilitychange', syncWhenVisible);
    window.addEventListener('focus', syncWhenVisible);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', syncWhenVisible);
      window.removeEventListener('focus', syncWhenVisible);
    };
  }, [loadData]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const offices = useMemo(() => getOffices(records), [records]);
  // A stale office selection (that office's PPMPs are gone) falls back to All.
  const activeFilters = offices.includes(filters.office) || filters.office === 'All'
    ? filters
    : { ...filters, office: 'All' };

  const filteredRecords = useMemo(
    () => filterEntryRecords(records, activeFilters).sort((a, b) => b.id - a.id),
    [records, activeFilters]
  );
  const approvedNumbers = useMemo(() => getApprovedEntryNumbers(records), [records]);
  const approvedCount = filteredRecords.filter((r) => r.status === 'Completed').length;

  // The open PPMP collapses by itself when the filters hide it.
  const openId = filteredRecords.some((r) => r.id === expandedId) ? expandedId : null;

  const setFilter = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));

  const openRecord = (id) => { setSelectedRecordId(id); setModalOpen(true); };

  // Collapsing a PPMP (or opening another) throws away its unsaved edits, so ask first.
  const toggleRow = (id) => {
    const nextId = expandedId === id ? null : id;
    if (expandedId !== null && dirtyRef.current) {
      setDialog({
        kind: 'discard',
        nextId,
        title: 'Discard unsaved changes?',
        text: 'You have unsaved changes in this PPMP. If you leave now they will be lost.',
        confirmLabel: 'Discard'
      });
      return;
    }
    setExpandedId(nextId);
  };

  const requestSubmit = (record) => {
    if (!isPpmpDraft(record)) return;
    const missing = getItemsMissingDocuments(record);
    if (missing.length > 0) return setToast(buildMissingDocsMessage(missing));
    const mismatch = getItemsBudgetModeMismatch(record);
    if (mismatch.length > 0) return setToast(buildBudgetMismatchMessage(mismatch));

    setDialog({
      kind: 'submit',
      record,
      title: `Submit PPMP No. ${record.ppmp_no || 'N/A'} for approval?`,
      text: (user?.stage === 'HEAD'
        ? 'Its status will change from Draft to For Approval and it goes straight to the TOD. '
        : 'Its status will change from Draft to For Approval and it goes to your Unit Head. ') +
        'While it is under review it can no longer be edited or get new items.',
      confirmLabel: 'Submit'
    });
  };

  const requestDelete = (record) => {
    if (isLatestApprovedCarryoverSource(record, readRecords())) {
      return setToast(`PPMP No. ${record.ppmp_no} for FY ${record.fiscal_year} is the latest approved plan and must remain available for carryover.`);
    }
    if (!canDeleteRecord(record, user)) {
      return setToast('An approved PPMP is closed and can only be deleted by an approver.');
    }
    setDialog({
      kind: 'delete',
      record,
      danger: true,
      title: 'Delete Request?',
      text: 'Are you sure you want to delete this procurement request? This action cannot be undone.',
      confirmLabel: 'Delete'
    });
  };

  const confirmDialog = () => {
    const { kind, record } = dialog;
    setDialog(null);
    if (kind === 'discard') {
      dirtyRef.current = false;
      setExpandedId(dialog.nextId);
      return;
    }
    if (kind === 'delete') {
      if (isLatestApprovedCarryoverSource(record, readRecords())) {
        setToast(`PPMP No. ${record.ppmp_no} for FY ${record.fiscal_year} is the latest approved plan and must remain available for carryover.`);
      } else {
        setToast(deleteRecordById(record.id) ? 'Request deleted.' : 'Could not delete the request.');
      }
      setExpandedId(null);
    } else {
      // Same path as the Request modal: validate, send to DTMS, then mark For Approval.
      setToast('Submitting to DTMS…');
      submitPpmpViaDtms(record.id, user)
        .then((res) => setToast(res.success ? res.message : res.error))
        .catch((err) => setToast(err.message))
        .finally(loadData);
      return;
    }
    loadData();
  };

  const appButton = APP_ROLES.includes(user?.role) ? getAppButtonInfo(user, readRecords()) : null;

  return (
    <div className="db-body">
      <Sidebar onNewRequest={() => { setSelectedRecordId(null); setModalOpen(true); }} />

      <main className="db-main">
        <div className="db-header-banner">
          <img src="/images/header-banner.png" alt="DICT Header Banner" />
        </div>

        <header className="db-topbar">
          <div>
            <h1 className="db-title">Entries</h1>
            <p className="db-subtitle">Review, filter, and open all created PPMP records.</p>
          </div>
          <div className="db-topbar-actions">
            {appButton && (
              <button
                type="button"
                className="db-app-btn is-secondary"
                title="Preview the Annual Procurement Plan before downloading it"
                onClick={() => setAppModalYear(appButton.year)}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                <span className="db-app-label">{appButton.label}</span>
              </button>
            )}
            <ExportMenu user={user} year={appButton?.year || new Date().getFullYear()} theme={theme} notify={setToast} />
            <button type="button" className="db-icon-btn" aria-label="Toggle dark/light mode" onClick={toggleTheme}>
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </header>

        <section className="db-entries-card">
          <div className="db-entries-tabs">
            <button type="button" className={`db-tab-btn ${tab === 'ppmp' ? 'active' : ''}`} onClick={() => setTab('ppmp')}>
              PPMP Requests
            </button>
            <button type="button" className={`db-tab-btn ${tab === 'app' ? 'active' : ''}`} onClick={() => setTab('app')}>
              Annual Procurement Plans (APP)
            </button>
          </div>

          {tab === 'ppmp' && (
            <>
              <div className="db-section-head">
                <div>
                  <h3>PPMP Entries</h3>
                  <p>All created PPMPs, numbered and ready to filter.</p>
                </div>
                <div className="db-entry-tools">
                  <label className={`db-filter-control${offices.length < 2 ? ' hidden' : ''}`}>
                    <span>Office</span>
                    <select value={activeFilters.office} onChange={setFilter('office')}>
                      <option value="All">All offices</option>
                      {offices.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </label>
                  <label className="db-filter-control">
                    <span>Status</span>
                    <select value={filters.status} onChange={setFilter('status')}>
                      <option value="All">All</option>
                      <option value="Draft">Draft</option>
                      <option value="For Approval">For Approval</option>
                      <option value="Completed">Completed</option>
                    </select>
                  </label>
                  <label className="db-filter-control">
                    <span>PPMP Type</span>
                    <select value={filters.indicative} onChange={setFilter('indicative')}>
                      <option value="All">All</option>
                      <option value="Indicative">Indicative</option>
                      <option value="Final">Final</option>
                    </select>
                  </label>
                  <label className="db-filter-control">
                    <span>Type</span>
                    <select value={filters.type} onChange={setFilter('type')}>
                      <option value="All">All</option>
                      <option value="Consulting Services">Consulting Services</option>
                      <option value="Goods">Goods</option>
                      <option value="Infrastructure">Infrastructure</option>
                    </select>
                  </label>
                  <label className="db-filter-control">
                    <span>Category</span>
                    <select value={filters.category} onChange={setFilter('category')}>
                      <option value="All">All</option>
                      <option value="General Requirements">General Requirements</option>
                      <option value="Miscellaneous">Miscellaneous</option>
                      <option value="Common Supplies and Equipment">Common Supplies and Equipment</option>
                    </select>
                  </label>
                  <label className="db-filter-control db-search-control">
                    <span>Search</span>
                    <input type="search" placeholder="PPMP, user, description" value={filters.search} onChange={setFilter('search')} />
                  </label>
                </div>
              </div>

              <div className="db-entries-summary">
                <span>
                  {filteredRecords.length} {filteredRecords.length === 1 ? 'entry' : 'entries'} · {approvedCount} approved
                </span>
              </div>

              <div className="db-entries-table-wrap">
                <table className="db-entries-table">
                  <thead>
                    <tr>
                      <th>No.</th>
                      <th>PPMP</th>
                      <th>Description</th>
                      <th>End-User</th>
                      <th>Type</th>
                      <th>Budget</th>
                      <th>Status</th>
                      <th>PPMP Type</th>
                      <th>Approved By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map((r) => {
                      const isOpen = openId === r.id;
                      const entryNumber = approvedNumbers.get(String(r.id));
                      const ppmpType = r.is_indicative === 'Final' ? 'Final' : r.is_indicative === 'Indicative' ? 'Indicative' : 'N/A';
                      return (
                        <React.Fragment key={r.id}>
                          <tr>
                            <td
                              className="db-entry-number"
                              style={entryNumber ? undefined : { opacity: 0.4 }}
                              title={entryNumber ? undefined : 'Numbered within its office once approved'}
                            >
                              {entryNumber || '—'}
                            </td>
                            <td
                              className={`db-entry-ppmp-cell${isOpen ? ' is-expanded' : ''}`}
                              onClick={() => toggleRow(r.id)}
                              title={`${isOpen ? 'Hide' : 'Show'} Excel preview`}
                            >
                              <svg className="db-entry-chevron" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4">
                                <path d="M9 6L15 12L9 18" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              <div>
                                <strong>PPMP No. {r.ppmp_no || 'N/A'}</strong>
                                <span>{r.fiscal_year || ''}</span>
                              </div>
                            </td>
                            <td className="db-entry-description">{getRecordDescriptionSummary(r)}</td>
                            <td>{r.end_user || 'N/A'}</td>
                            <td>{getRecordProjectTypeSummary(r)}</td>
                            <td>{formatPeso(getRecordTotalBudget(r))}</td>
                            <td><StatusPill record={r} user={user} /></td>
                            <td>
                              {ppmpType === 'N/A'
                                ? 'N/A'
                                : <span className={`db-status-pill ${ppmpType === 'Final' ? 'is-type-final' : 'is-type-indicative'}`}>{ppmpType}</span>}
                            </td>
                            <td><ApprovedByCell record={r} /></td>
                          </tr>

                          {isOpen && (
                            <tr className="db-entry-expand-row">
                              <td colSpan="9">
                                <PpmpExpanded
                                  key={r.id}
                                  record={r}
                                  user={user}
                                  onView={() => openRecord(r.id)}
                                  onPreview={() => setPreviewRecord(r)}
                                  onDelete={() => requestDelete(r)}
                                  onSubmit={() => requestSubmit(r)}
                                  onPdf={() => generatePPMP_PDF(r)}
                                  onXlsx={() => exportPPMP_Excel(r)}
                                  onSaved={loadData}
                                  onToast={setToast}
                                  onDirtyChange={handleDirtyChange}
                                />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {filteredRecords.length === 0 && (
                  <div className="db-entries-empty">No PPMP entries match the current filters.</div>
                )}
              </div>
            </>
          )}

          {tab === 'app' && (
            <div className="db-entries-table-wrap">
              <table className="db-entries-table">
                <thead>
                  <tr>
                    <th>Fiscal Year</th>
                    <th>Plan Title</th>
                    <th>Status</th>
                    <th>Current Approver</th>
                    <th>Submitted By</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {apps.map((a) => (
                    <tr key={a.fiscal_year}>
                      <td>FY {a.fiscal_year}</td>
                      <td>Annual Procurement Plan for FY {a.fiscal_year}</td>
                      <td><span className={`db-status-pill ${statusClass(a.status)}`}>{a.status}</span></td>
                      <td>{a.currentApproverRole || '—'}</td>
                      <td>{a.submitted_by?.name || '—'}</td>
                      <td>
                        <button
                          type="button"
                          className="db-action-btn"
                          style={{ width: 'auto', padding: '6px 14px' }}
                          onClick={() => setAppModalYear(a.fiscal_year)}
                        >
                          Open APP &rarr;
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      <RequestModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        recordId={selectedRecordId}
        onSaved={loadData}
        onBulkImport={(formHeader) => {
          setBulkHeader(formHeader || null);
          setModalOpen(false);
          setBulkOpen(true);
        }}
      />
      <BulkImportModal
        isOpen={bulkOpen}
        onClose={() => setBulkOpen(false)}
        headerData={bulkHeader}
        onSuccess={(res) => {
          loadData();
          setToast(`${res.count} ${res.count === 1 ? 'item' : 'items'} imported under PPMP No. ${res.ppmp_no}.` +
            (res.converted ? ` ${res.converted} switched to Two Failed Biddings.` : '') +
            ' Attach the supporting documents before submitting.');
        }}
      />
      {appModalYear && (
        <AppPreviewModal isOpen={!!appModalYear} onClose={() => setAppModalYear(null)} fiscalYear={appModalYear} onUpdated={loadData} />
      )}
      <ExcelPreviewModal
        record={previewRecord}
        onClose={() => setPreviewRecord(null)}
        onOpenRequest={(id) => { setPreviewRecord(null); openRecord(id); }}
        notify={setToast}
      />
      <ConfirmDialog dialog={dialog} onCancel={() => setDialog(null)} onConfirm={confirmDialog} />
      <div className={`db-toast${toast ? ' show' : ''}`} role="status">{toast}</div>
    </div>
  );
}