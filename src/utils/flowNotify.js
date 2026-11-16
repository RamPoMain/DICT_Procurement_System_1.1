// Turns a status/stage change into an e-mail notification request (see server/admin-api.js).
// Compares the record before and after the change, so repeated saves never send repeats.
import { notifyFlow } from './adminApi.js';

const lastRemark = (record) => {
  const history = Array.isArray(record?.remarksHistory) ? record.remarksHistory : [];
  return history.length ? String(history[history.length - 1].remarks || '') : '';
};

function notifyChange(kind, record, before, stages, round) {
  if (!record) return;
  const status = record.status;
  const stage = record.currentApproverRole;
  const wasWaiting = before?.status === 'For Approval';

  if (status === 'Completed' && before?.status !== 'Completed') {
    notifyFlow({ kind, event: 'final', record, round });
  } else if (status === 'For Approval' && stages.includes(stage) && (!wasWaiting || before?.stage !== stage)) {
    notifyFlow({ kind, event: 'arrived', stage, record, round });
  } else if (status === 'Draft' && record.returned_for_revision && wasWaiting) {
    notifyFlow({ kind, event: 'returned', record, remarks: lastRemark(record), round });
  }
}

// before = { status, stage } taken just before the change.
export const notifyPpmpChange = (record, before) =>
  notifyChange('ppmp', record, before, ['HEAD', 'TOD', 'BO', 'RD'], Number(record?.submission_round) || 1);

export const notifyAppChange = (record, before) =>
  notifyChange('app', record, before, ['SUP', 'ARD', 'RD'], record?.submitted_at || '');
