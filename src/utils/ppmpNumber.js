import { readPpmpYearCounters, ppmpYearCounterKey } from './procurementRules.js';

// Next PPMP number for one office + fiscal year.
//
// The old rule was "number of PPMPs + 1", which hands out a number that is
// already taken once one PPMP in the middle is deleted (1, 3 -> next = 3).
// This takes the largest of:
//   - the highest PPMP number that exists now,
//   - how many PPMPs exist (covers non-numeric / missing numbers),
//   - the highest number ever APPROVED (the per-year counter in
//     procurementRules.js, which survives deletions).
export function getNextPpmpNumber(records, office, fiscalYear) {
  const year = String(fiscalYear || '').trim();
  const officeKey = String(office || '').trim().toLowerCase();

  let highest = 0;
  let count = 0;
  (records || []).forEach((r) => {
    if (!r) return;
    if (String(r.end_user || '').trim().toLowerCase() !== officeKey) return;
    if (String(r.fiscal_year || '').trim() !== year) return;
    count += 1;
    const n = parseInt(r.ppmp_no, 10);
    if (!isNaN(n) && n > highest) highest = n;
  });

  const counter = Number(readPpmpYearCounters()[ppmpYearCounterKey(office, year)]) || 0;
  return String(Math.max(highest, count, counter) + 1);
}
