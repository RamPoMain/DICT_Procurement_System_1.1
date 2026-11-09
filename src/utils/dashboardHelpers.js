// Helpers ported from the original dashboard-logic.js.
// Put this next to procurementRules.js (e.g. src/utils/dashboardHelpers.js).
// Everything here is pure: no DOM access, no localStorage writes.

export function readRecords() {
  try {
    const all = JSON.parse(localStorage.getItem('procurement_records'));
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

// Draft -> For Approval -> Completed. Old 'Pending ...' statuses count as Draft.
export function getPpmpStatus(record) {
  if (!record) return 'Draft';
  if (record.status === 'Completed') return 'Completed';
  if (record.status === 'For Approval') return 'For Approval';
  return 'Draft';
}

export const isPpmpClosed = (record) => !!record && record.status === 'Completed';

// A Draft that an approver sent back for revision.
export const isPpmpReturned = (record) =>
  !!record && getPpmpStatus(record) === 'Draft' && !!record.returned_for_revision;

// Approved PPMPs can only be deleted by an approver.
export const canDeleteRecord = (record, user) =>
  !isPpmpClosed(record) || !!user?.canApprove;

// Which PPMPs this account can see (same four rules as the original getRecords()).
export function getVisibleRecords(all, user) {
  if (!user) return [];
  return all.filter((r) => {
    const status = getPpmpStatus(r);

    // 1. Requesters see everything from their own office, drafts included.
    if (user.canRequest && r.end_user === user.office) return true;

    // 2. Approved PPMPs are visible to reviewers (not to requesting offices).
    if (r.status === 'Completed' && !user.canRequest) return true;

    // 3. Tracking accounts (Suppliers) see submitted + approved, never drafts.
    if (user.canTrackApprovals && (status === 'For Approval' || status === 'Completed')) return true;

    // 4. Approvers see PPMPs waiting at their stage, or ones they already acted on.
    //    Unit Heads: own office only.
    if (user.canApprove && status === 'For Approval') {
      if (user.stage === 'HEAD' && r.end_user !== user.headOf) return false;
      if (r.currentApproverRole === user.stage) return true;
      const history = Array.isArray(r.remarksHistory) ? r.remarksHistory : [];
      if (history.some((h) => h.stage === user.stage)) return true;
    }

    return false;
  });
}

// True when this account is an approver AND the record is waiting at their stage.
export function canActOnRecord(record, user) {
  if (!user || !user.canApprove || !record) return false;
  if (getPpmpStatus(record) !== 'For Approval') return false;
  if (record.currentApproverRole !== user.stage) return false;
  if (user.stage === 'HEAD') return record.end_user === user.headOf;
  return true;
}

// "just now", "5 min ago", "2 hr ago", "3 days ago", or a date after a week.
export function formatRelativeTime(timestamp) {
  const ts = Number(timestamp);
  const diffMs = Date.now() - ts;
  if (isNaN(ts) || diffMs < 0) return '';

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'just now';
  if (diffMs < hour) return Math.floor(diffMs / minute) + ' min ago';
  if (diffMs < day) return Math.floor(diffMs / hour) + ' hr ago';
  if (diffMs < 7 * day) {
    const d = Math.floor(diffMs / day);
    return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  }
  return new Date(ts).toLocaleDateString();
}

// Text after the time in the Recent Activity row.
export function activityNote(record) {
  const status = getPpmpStatus(record);
  if (isPpmpClosed(record) && record.approved_by) return ' · Approved by ' + record.approved_by.name;
  if (status === 'For Approval') return ' · For approval';
  if (status === 'Draft') return isPpmpReturned(record) ? ' · Returned for revision' : ' · Draft';
  return '';
}

// Badge shown for an APP in the dashboard's APP section.
export function getAppBadge(app) {
  if (app.status === 'Completed') return { className: 'is-completed', label: 'Final (Approved)' };
  if (app.status === 'For Approval') {
    const who = app.currentApproverRole === 'ARD' ? 'ARD' : 'RD';
    return { className: 'is-pending', label: `Under Review (${who})` };
  }
  if (app.returned_for_revision) return { className: 'is-returned', label: 'Returned' };
  return { className: 'is-draft', label: 'Draft' };
}

// True when an APP is waiting on this account's role (drives the notification dot).
export function isAppPendingForUser(apps, user) {
  if (!user) return false;
  return apps.some((a) => a.status === 'For Approval' && a.currentApproverRole === user.role);
}
