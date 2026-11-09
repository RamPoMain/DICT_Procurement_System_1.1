import React, { useEffect, useRef, useState } from 'react';
import { exportAppTemplateExcel, exportAppExcel, EXPORT_ROLES } from '../../utils/appTemplateExport.js';
import '../../assets/styles/entries-export.css';

const OPTIONS = [
  {
    id: 'philgeps',
    title: 'PhilGEPS APP template',
    hint: 'Upload-ready Excel file, columns A to N',
    run: exportAppTemplateExcel
  },
  {
    id: 'layout',
    title: 'APP as Excel',
    hint: 'Same layout as the PDF, with signatories',
    run: exportAppExcel
  }
];

// Suppliers only. Shown in the Entries top bar next to the APP preview button.
export default function ExportMenu({ user, year, theme, notify }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user || !EXPORT_ROLES.includes(user.role)) return null;

  const run = async (option) => {
    setOpen(false);
    setBusyId(option.id);
    try {
      await option.run(year, { session: user, notify });
    } finally {
      setBusyId(null);
    }
  };

  const busy = busyId !== null;

  return (
    <div className="db-export" data-theme={theme} ref={wrapRef}>
      <button
        type="button"
        className="db-export-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <span>{busy ? 'Preparing file…' : 'Export Excel'}</span>
        <svg className="db-export-caret" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="db-export-menu" role="menu" aria-label={`Export the FY ${year} APP`}>
          {OPTIONS.map((o) => (
            <button key={o.id} type="button" role="menuitem" className="db-export-item" onClick={() => run(o)}>
              <strong>{o.title}</strong>
              <span>{o.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
