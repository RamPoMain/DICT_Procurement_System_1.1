import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import BulkImportModal from '../modals/BulkImportModal.jsx';
import {
  getRecordItems,
  isPpmpDraft,
  parseBudgetNumber,
  formatPesoExact,
  calculateDeduplicatedBudget,
  itemHasSupportingDocument,
  getItemsMissingDocuments,
  getItemsBudgetModeMismatch,
  getRequiredDocLabel,
  getRecommendedMode,
  isBracketMismatch,
  MODE_BUDGET_BRACKETS
} from '../../utils/procurementRules.js';
import { canDeleteRecord } from '../../utils/dashboardHelpers.js';
import {
  ITEM_FILTER_DEFAULTS,
  isItemFilterActive,
  itemMatchesFilter,
  getItemFilterOptions
} from '../../utils/entriesHelpers.js';
import {
  PROJECT_TYPES,
  GENERAL_REQUIREMENT_CHOICES,
  MODE_GROUPS,
  FAILED_BIDDING_MODE,
  CRITERIA_OPTIONS,
  STRATEGY_OPTIONS,
  EDITABLE_FIELDS,
  isFailedBiddingItem,
  blankItem,
  cloneItemsForEdit,
  itemsSignature,
  cleanBudgetInput,
  parseBudgetInput,
  nextDay,
  dateFloor,
  validateItem,
  normalizeItemsForSave,
  saveRecordItems
} from '../../utils/itemEditing.js';
import {
  MAX_FILE_SIZE,
  hasStoredContent,
  formatFileSize,
  newFileId,
  putFile,
  removeFile,
  openStoredDoc,
  downloadStoredDoc,
  screenFiles
} from '../../utils/itemDocs.js';

const CS_COLUMNS = [6, 14]; // Criteria + Strategies: Draft-only columns

/* ------------------------------------------------------------------ */
/* Read-only cells                                                     */
/* ------------------------------------------------------------------ */
const List = ({ values }) => {
  const list = (Array.isArray(values) ? values : [values])
    .map((v) => String(v == null ? '' : v).trim())
    .filter(Boolean);
  if (list.length === 0) return <span className="ep-none">None</span>;
  return <ul className="ep-list">{list.map((v, i) => <li key={i}>{v}</li>)}</ul>;
};

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none">
    <path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const RemoveIcon = ({ size = 11 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none">
    <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

// One attached file: the name opens it, the arrow downloads it. A file whose
// contents were never stored shows as plain text.
function DocItem({ doc, toast, onRemove }) {
  const name = (doc && doc.name) || 'Document';
  return (
    <li className={hasStoredContent(doc) || onRemove ? 'ep-doc-item' : undefined}>
      {hasStoredContent(doc) ? (
        <>
          <button type="button" className="ep-doc-link" title={`Open ${name}`} onClick={() => openStoredDoc(doc, toast)}>
            {name}
          </button>
          <button
            type="button" className="ep-doc-download" title={`Download ${name}`} aria-label={`Download ${name}`}
            onClick={() => downloadStoredDoc(doc, toast)}
          >
            <DownloadIcon />
          </button>
        </>
      ) : <span>{name}</span>}
      {onRemove && (
        <button type="button" className="ep-doc-remove" title={`Remove ${name}`} aria-label={`Remove ${name}`} onClick={onRemove}>
          <RemoveIcon />
        </button>
      )}
    </li>
  );
}

const Docs = ({ item, toast }) => {
  const docs = Array.isArray(item.supporting_documents) ? item.supporting_documents : [];
  if (docs.length === 0) return <span className="ep-none">None</span>;
  return (
    <ul className="ep-list ep-doc-list">
      {docs.map((d, i) => <DocItem key={i} doc={d} toast={toast} />)}
    </ul>
  );
};

/* ------------------------------------------------------------------ */
/* Filter bar                                                          */
/* ------------------------------------------------------------------ */
function FilterBar({ items, filters, setFilters, shown }) {
  const opts = useMemo(() => getItemFilterOptions(items), [items]);
  const active = isItemFilterActive(filters);
  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }));

  const select = (key, label, values) => (
    <select value={filters[key]} onChange={set(key)}>
      <option value="All">{label}</option>
      {values.map((v) => <option key={v} value={v}>{v}</option>)}
    </select>
  );

  return (
    <div className="ep-filter-bar" role="search" aria-label="Filter items in this PPMP">
      <label className="db-filter-control ep-filter-search">
        <span>Search items</span>
        <input
          type="search"
          placeholder="Description, remarks, fund source…"
          value={filters.search}
          onChange={set('search')}
        />
      </label>
      <label className="db-filter-control">
        <span>Item type</span>
        {select('type', 'All types', opts.types)}
      </label>
      <label className="db-filter-control">
        <span>Category</span>
        <select value={filters.category} onChange={set('category')}>
          <option value="All">All categories</option>
          {opts.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          {opts.hasUncategorized && <option value="__none__">None / Not applicable</option>}
        </select>
      </label>
      <label className="db-filter-control">
        <span>Mode</span>
        {select('mode', 'All modes', opts.modes)}
      </label>
      <label className="db-filter-control">
        <span>Documents</span>
        <select value={filters.docs} onChange={set('docs')}>
          <option value="All">All</option>
          <option value="with">With document</option>
          <option value="missing">Missing document</option>
        </select>
      </label>
      <div className="ep-filter-meta">
        <span className="ep-filter-count" aria-live="polite">
          {active ? `Showing ${shown} of ${items.length} items` : `${items.length} items`}
        </span>
        {active && (
          <button type="button" className="ep-filter-clear" onClick={() => setFilters(ITEM_FILTER_DEFAULTS)}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */
const PlusIcon = ({ size = 13 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2">
    <path d="M12 5V19M5 12H19" strokeLinecap="round" />
  </svg>
);

function Toolbar({
  record, user, editing, dirty, canEdit, confirmingDiscard,
  onView, onPreview, onDelete, onSubmit, onPdf, onXlsx,
  onEdit, onAddItem, onBulkImport, onCancel, onKeepEditing, onDiscard, onSave
}) {
  const draft = isPpmpDraft(record);
  const canReq = !!user?.canRequest;

  if (editing) {
    return (
      <div className="ep-toolbar">
        <div className="ep-toolbar-status">
          <span className={`ep-dirty-indicator${dirty ? '' : ' hidden'}`}>Unsaved changes</span>
          {confirmingDiscard && <span className="ep-doc-warning">Discard your unsaved changes to this PPMP?</span>}
        </div>
        <div className="ep-toolbar-actions">
          {confirmingDiscard ? (
            <>
              <button type="button" className="ep-discard-btn" onClick={onKeepEditing}>Keep editing</button>
              <button type="button" className="ep-save-btn" onClick={onDiscard}>Discard changes</button>
            </>
          ) : (
            <>
              <button type="button" className="ep-add-btn" onClick={onAddItem}>
                <PlusIcon /> Add Item
              </button>
              <button type="button" className="ep-discard-btn" onClick={onCancel}>Cancel</button>
              <button type="button" className="ep-save-btn" onClick={onSave}>Save Changes</button>
            </>
          )}
        </div>
      </div>
    );
  }

  const missing = draft ? getItemsMissingDocuments(record) : [];
  const mismatch = draft ? getItemsBudgetModeMismatch(record) : [];
  const blocked = missing.length > 0 || mismatch.length > 0;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="ep-toolbar">
      <div className="ep-toolbar-status">
        {missing.length > 0 && (
          <span className="ep-doc-warning" title="Submit for Approval is blocked until every item has a supporting document">
            {plural(missing.length, 'item needs', 'items need')} a supporting document
          </span>
        )}
        {mismatch.length > 0 && (
          <span className="ep-doc-warning" title="Submit for Approval is blocked until every item's Mode of Procurement matches its budget">
            {plural(mismatch.length, 'item has', 'items have')} a mode/budget mismatch
          </span>
        )}
      </div>
      <div className="ep-toolbar-actions">
        <div className="db-entry-actions">
          {canEdit && (
            <button type="button" className="db-action-btn" title="Add another entry to this PPMP" onClick={onAddItem}>
              <PlusIcon size={14} />
            </button>
          )}
          {canEdit && (
            <button type="button" className="db-action-btn" title="Bulk import items from Excel into this PPMP" onClick={onBulkImport}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 15V4m0 0L8 8m4-4l4 4M5 20h14" />
              </svg>
            </button>
          )}
          <button type="button" className="db-action-btn" title="View Details" onClick={onView}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          {onPreview && (
            <button type="button" className="db-action-btn" title="Preview this PPMP (Excel view)" onClick={onPreview}>
              Preview
            </button>
          )}
          <button type="button" className="db-action-btn" title="Export PDF" onClick={onPdf}>PDF</button>
          <button type="button" className="db-action-btn" title="Export Excel" onClick={onXlsx}>XLSX</button>
          {canDeleteRecord(record, user) && (
            <button type="button" className="db-action-btn delete" title="Delete" onClick={onDelete}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
              </svg>
            </button>
          )}
        </div>
        {draft && canReq && (
          <button
            type="button"
            className={`ep-submit-btn${blocked ? ' is-blocked' : ''}`}
            aria-disabled={blocked || undefined}
            title={blocked ? 'Resolve the flagged items before submitting' : undefined}
            onClick={onSubmit}
          >
            Submit for Approval
          </button>
        )}
        {canEdit && <button type="button" className="ep-save-btn" onClick={onEdit}>Edit</button>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editable row                                                        */
/* ------------------------------------------------------------------ */
function BracketHint({ item }) {
  const n = parseBudgetInput(item.budget);
  const mode = String(item.mode || '').trim();
  const chosen = MODE_BUDGET_BRACKETS.find((t) => t.mode === mode);
  if (!(n > 0) || (chosen && isBracketMismatch(mode, n))) return null;
  const rec = getRecommendedMode(n);
  return (
    <div className="ep-bracket-hint">
      Recommended for this budget: {rec.mode} ({rec.label})
    </div>
  );
}

function DocEditor({ item, toast, onPick, onRemoveDoc }) {
  const inputRef = useRef(null);
  const docs = Array.isArray(item.supporting_documents) ? item.supporting_documents : [];
  const required = PROJECT_TYPES.includes(item.project_type) ? getRequiredDocLabel(item.project_type) : '';

  return (
    <div className="ep-doc-cell-body">
      {docs.length === 0 ? (
        <span className="ep-none">None attached</span>
      ) : (
        <ul className="ep-list ep-doc-list">
          {docs.map((d, i) => (
            <DocItem key={d.fileId || i} doc={d} toast={toast} onRemove={() => onRemoveDoc(item.id, i)} />
          ))}
        </ul>
      )}
      <input
        ref={inputRef} type="file" multiple hidden
        onChange={(e) => { onPick(item.id, e.target.files); e.target.value = ''; }}
      />
      <button type="button" className="ep-doc-attach-btn" onClick={() => inputRef.current && inputRef.current.click()}>
        + Attach file
      </button>
      <div className="ep-doc-hint">
        {required ? `Required: ${required}. ` : 'Pick a project type to see the required document. '}
        Max {formatFileSize(MAX_FILE_SIZE)} per file.
      </div>
    </div>
  );
}

function EditableRow({ item, messages, toast, onField, onBlurField, onToggleStrategy, onRemove, onPickFiles, onRemoveDoc }) {
  const locked = isFailedBiddingItem(item);
  const err = (field) => (messages[field]
    ? <div className="ep-cell-error" role="alert">{messages[field]}</div>
    : null);
  const cls = (field, extra = '') => `ep-input${extra ? ` ${extra}` : ''}${messages[field] ? ' is-invalid' : ''}`;
  const attrs = (field) => ({ 'data-item-id': item.id, 'data-field': field });

  const text = (field, props = {}) => ({
    ...attrs(field),
    className: cls(field, props.extraClass),
    value: item[field] ?? '',
    onChange: (e) => onField(item.id, field, e.target.value),
    onBlur: () => onBlurField(item.id, field),
    ...props.rest
  });
  const pick = (field, props = {}) => ({
    ...attrs(field),
    className: cls(field),
    value: item[field] ?? '',
    onChange: (e) => onField(item.id, field, e.target.value, true),
    onBlur: () => onBlurField(item.id, field),
    ...props
  });
  const date = (field, min) => pick(field, { type: 'date', min, max: '2100-12-31' });

  const strategies = Array.isArray(item.strategies) ? item.strategies : [];
  const lockedStyle = { background: '#f3f4f6', cursor: 'not-allowed', fontWeight: 600, color: '#374151' };

  return (
    <tr className="ep-item-row ep-item-row-editing">
      {/* 1. Ref No. (assigned on first save) + Object Code */}
      <td>
        <div>{item.reference_no || <span className="ep-none">Assigned on save</span>}</div>
        <input
          {...text('object_name', { rest: { placeholder: 'Object code', inputMode: 'numeric', autoComplete: 'off' } })}
          aria-label="Object code"
          style={{ marginTop: 6 }}
        />
        {err('object_name')}
      </td>

      {/* 2. Description */}
      <td>
        <textarea {...text('project_description', { rest: { rows: 2, placeholder: 'Describe the project...' } })} />
        {err('project_description')}
      </td>

      {/* 3. Project type */}
      <td>
        <select {...pick('project_type')}>
          <option value="">Select...</option>
          {PROJECT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {err('project_type')}
      </td>

      {/* 4. Quantity and size */}
      <td>
        <textarea {...text('quantity_size', { rest: { rows: 2, placeholder: 'Quantity and size...' } })} />
        {err('quantity_size')}
      </td>

      {/* 5. Mode of procurement */}
      <td>
        {locked ? (
          <input
            type="text" className="ep-input" readOnly disabled style={lockedStyle}
            value={item.mode || FAILED_BIDDING_MODE}
            title="Locked: Automated under RA 12009 Sec. 33 (Two Failed Biddings)"
          />
        ) : (
          <select {...pick('mode')}>
            <option value="">Select mode...</option>
            {MODE_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </optgroup>
            ))}
          </select>
        )}
        {err('mode')}
      </td>

      {/* 6. Pre-procurement conference */}
      <td>
        <select {...pick('pre_procurement')}>
          <option value="">Select...</option>
          <option value="No">No</option>
          <option value="Yes">Yes</option>
        </select>
        {err('pre_procurement')}
      </td>

      {/* 7. Criteria for bid evaluation */}
      <td className="ep-cs-col">
        {locked ? (
          <input type="text" className="ep-input" readOnly disabled style={lockedStyle} value="Negotiated" title="Locked: Negotiated criteria" />
        ) : (
          <select {...pick('bid_evaluation_criteria')}>
            <option value="">Select...</option>
            {CRITERIA_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {err('bid_evaluation_criteria')}
      </td>

      {/* 8-12. Timeline */}
      <td><input {...date('start_date', '2000-01-01')} />{err('start_date')}</td>
      <td><input {...date('bid_opening_date', dateFloor(item, 'bid_opening_date'))} />{err('bid_opening_date')}</td>
      <td><input {...date('notice_of_award_date', dateFloor(item, 'notice_of_award_date'))} />{err('notice_of_award_date')}</td>
      <td><input {...date('end_date', dateFloor(item, 'end_date'))} />{err('end_date')}</td>
      <td>
        <input {...date('delivery_period', item.end_date ? nextDay(item.end_date) : '2000-01-01')} />
        {err('delivery_period')}
      </td>

      {/* 13. Source of funds */}
      <td>
        <input type="text" {...text('fund_source', { rest: { placeholder: 'Source of funds' } })} />
        {err('fund_source')}
      </td>

      {/* 14. Estimated budget */}
      <td>
        <input
          type="text"
          {...text('budget', { extraClass: 'ep-budget', rest: { placeholder: '0.00', inputMode: 'decimal', autoComplete: 'off' } })}
        />
        {err('budget')}
        <BracketHint item={item} />
      </td>

      {/* 15. Strategies */}
      <td className="ep-cs-col" style={{ minWidth: 220, width: 220, verticalAlign: 'top' }}>
        <div className={`ep-strategies-box${messages.strategies ? ' is-invalid' : ''}`}>
          {STRATEGY_OPTIONS.map((opt) => (
            <label key={opt} className="ep-strategy-opt">
              <input
                type="checkbox" value={opt}
                checked={strategies.includes(opt)}
                onChange={(e) => onToggleStrategy(item.id, opt, e.target.checked)}
              />
              <span>{opt}</span>
            </label>
          ))}
        </div>
        {err('strategies')}
      </td>

      {/* 16. Supporting documents */}
      <td className="ep-doc-cell" style={{ minWidth: 180, width: 180, verticalAlign: 'top' }}>
        <DocEditor item={item} toast={toast} onPick={onPickFiles} onRemoveDoc={onRemoveDoc} />
      </td>

      {/* 17. General requirements */}
      <td>
        <select {...pick('general_requirements')}>
          <option value="">None / Not applicable</option>
          {GENERAL_REQUIREMENT_CHOICES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </td>

      {/* 18. Remarks */}
      <td>
        <textarea {...text('remarks', { rest: { rows: 2, placeholder: 'Remarks' } })} />
        {err('remarks')}
      </td>

      {/* Remove */}
      <td className="ep-remove-cell">
        <button type="button" className="ep-remove-btn" title="Remove this item" onClick={() => onRemove(item.id)}>
          <RemoveIcon size={13} />
        </button>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */
export default function PpmpExpanded({
  record, user, onView, onPreview, onDelete, onSubmit, onPdf, onXlsx,
  onSaved, onToast, onDirtyChange
}) {
  // Parent renders this with key={record.id}, so state resets when another PPMP opens.
  const [filters, setFilters] = useState(ITEM_FILTER_DEFAULTS);

  // draft === null -> read-only view. Otherwise { items, touched } is the working
  // copy; nothing reaches localStorage until Save Changes.
  const [draft, setDraft] = useState(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [pending, setPending] = useState({ count: 0, bytes: 0 });
  const [focusId, setFocusId] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const editSession = useRef(0);       // bumps on every start/stop of editing
  const addedFiles = useRef([]);       // files stored during this edit (cleaned up on discard)

  const toast = useCallback((msg) => { if (onToast) onToast(msg); }, [onToast]);

  const editing = draft !== null;
  const savedItems = getRecordItems(record);
  const canEdit = isPpmpDraft(record) && !!user?.canRequest;
  const showCS = isPpmpDraft(record);

  const dirty = useMemo(
    () => editing && itemsSignature(draft.items) !== itemsSignature(savedItems),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, draft, record]
  );

  useEffect(() => {
    if (onDirtyChange) onDirtyChange(dirty);
    return () => { if (onDirtyChange) onDirtyChange(false); };
  }, [dirty, onDirtyChange]);

  // Collapsing the dropdown (unmount) discards the draft and the files it stored.
  useEffect(() => () => {
    editSession.current += 1;
    addedFiles.current.forEach(removeFile);
    addedFiles.current = [];
  }, []);

  // Put the cursor in a freshly added row.
  useEffect(() => {
    if (focusId == null) return;
    const el = document.querySelector(`[data-item-id="${focusId}"][data-field="project_description"]`);
    if (el) {
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.focus({ preventScroll: true });
    }
    setFocusId(null);
  }, [focusId]);

  /* ---------------- validation (recomputed from the draft) ---------------- */
  const errorMap = useMemo(() => {
    const out = {};
    if (editing) draft.items.forEach((it) => { out[it.id] = validateItem(it); });
    return out;
  }, [editing, draft]);

  // Errors only show for fields the person has visited, or everywhere after a
  // failed Save. A mode that doesn't fit the budget shows on both fields.
  const messagesFor = (item) => {
    const errs = errorMap[item.id] || {};
    const touched = (draft && draft.touched[item.id]) || {};
    const out = {};
    EDITABLE_FIELDS.forEach((f) => {
      if (!errs[f]) return;
      const sharedBracket = (f === 'mode' || f === 'budget') && errs.mode === errs.budget && (touched.mode || touched.budget);
      if (submitAttempted || touched[f] || sharedBracket) out[f] = errs[f];
    });
    return out;
  };

  /* ---------------- edit-mode actions ---------------- */
  const startEdit = () => {
    if (!user?.canRequest) return toast('Your account is view/approve only and cannot edit requests.');
    if (!isPpmpDraft(record)) return toast('This PPMP is locked and can no longer be edited.');
    editSession.current += 1;
    addedFiles.current = [];
    setSubmitAttempted(false);
    setConfirmingDiscard(false);
    setDraft({ items: cloneItemsForEdit(record), touched: {} });
  };

  const stopEditing = () => {
    editSession.current += 1;
    setDraft(null);
    setSubmitAttempted(false);
    setConfirmingDiscard(false);
  };

  const addItem = () => {
    if (!canEdit) return toast('Your account is view/approve only and cannot add items.');
    const fresh = blankItem();
    setDraft((d) => (d
      ? { ...d, items: [...d.items, fresh] }
      : { items: [...cloneItemsForEdit(record), fresh], touched: {} }));
    if (!editing) {
      editSession.current += 1;
      addedFiles.current = [];
      setSubmitAttempted(false);
    }
    setFocusId(fresh.id);
  };

  const removeItem = (id) => {
    if (draft.items.length <= 1) {
      return toast('A PPMP needs at least one item — add a replacement before removing this one.');
    }
    setDraft((d) => ({ ...d, items: d.items.filter((it) => it.id !== id) }));
  };

  const touch = (touched, id, field) => ({ ...touched, [id]: { ...(touched[id] || {}), [field]: true } });

  const changeField = (id, field, raw, markTouched = false) => {
    let value = raw;
    if (field === 'budget') value = cleanBudgetInput(raw);          // digits + one decimal point
    if (field === 'object_name') value = raw.replace(/\D/g, '');     // digits only
    setDraft((d) => ({
      ...d,
      items: d.items.map((it) => (it.id === id ? { ...it, [field]: value } : it)),
      touched: markTouched ? touch(d.touched, id, field) : d.touched
    }));
  };

  // Leaving a box counts as "done typing", so its error (if any) can show.
  const blurField = (id, field) => setDraft((d) => (d ? { ...d, touched: touch(d.touched, id, field) } : d));

  const toggleStrategy = (id, option, checked) => {
    setDraft((d) => ({
      ...d,
      items: d.items.map((it) => {
        if (it.id !== id) return it;
        let set = new Set(Array.isArray(it.strategies) ? it.strategies : []);
        if (option === 'N/A') set = checked ? new Set(['N/A']) : (set.delete('N/A'), set);
        else if (checked) { set.delete('N/A'); set.add(option); } else set.delete(option);
        return { ...it, strategies: Array.from(set) };
      }),
      touched: touch(d.touched, id, 'strategies')
    }));
  };

  /* ---------------- supporting documents ---------------- */
  const pickFiles = (id, fileList) => {
    const files = Array.from(fileList || []);
    const item = draft && draft.items.find((it) => it.id === id);
    if (!item || files.length === 0) return;

    const { accepted, problems } = screenFiles(files, item.supporting_documents, pending.bytes);
    if (problems.length) toast(problems[0] + (problems.length > 1 ? ` (+${problems.length - 1} more)` : ''));

    const session = editSession.current;
    accepted.forEach((file) => {
      setPending((p) => ({ count: p.count + 1, bytes: p.bytes + file.size }));
      const fileId = newFileId();
      Promise.resolve(putFile(fileId, file)).then(() => {
        setPending((p) => ({ count: p.count - 1, bytes: p.bytes - file.size }));
        if (editSession.current !== session) { removeFile(fileId); return; }   // edit ended meanwhile
        addedFiles.current.push(fileId);
        const doc = { name: file.name, size: file.size, type: file.type || '', fileId };
        setDraft((d) => d && ({
          ...d,
          items: d.items.map((it) => (it.id === id
            ? { ...it, supporting_documents: [...(it.supporting_documents || []), doc] }
            : it))
        }));
      }).catch(() => {
        setPending((p) => ({ count: p.count - 1, bytes: p.bytes - file.size }));
        toast(`"${file.name}" could not be stored in this browser (storage may be full). Please try again.`);
      });
    });
  };

  const removeDoc = (id, index) => {
    setDraft((d) => ({
      ...d,
      items: d.items.map((it) => (it.id === id
        ? { ...it, supporting_documents: (it.supporting_documents || []).filter((_, i) => i !== index) }
        : it))
    }));
  };

  /* ---------------- save / cancel ---------------- */
  const discard = () => {
    addedFiles.current.forEach(removeFile);
    addedFiles.current = [];
    stopEditing();
  };

  const requestCancel = () => {
    if (!dirty) return discard();
    setConfirmingDiscard(true);
  };

  const save = () => {
    if (pending.count > 0) return toast('Still attaching files - wait a moment, then press Save Changes again.');
    setSubmitAttempted(true);

    const cleaned = normalizeItemsForSave(draft.items);
    const problemCount = cleaned.reduce((n, it) => n + Object.keys(validateItem(it)).length, 0);
    if (problemCount > 0) {
      toast(`Please fix ${problemCount} highlighted ${problemCount === 1 ? 'field' : 'fields'} before saving.`);
      setTimeout(() => {
        const bad = document.querySelector('.ep-input.is-invalid, .ep-strategies-box.is-invalid');
        if (!bad) return;
        if (bad.scrollIntoView) bad.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (bad.tagName !== 'DIV') bad.focus({ preventScroll: true });
      }, 0);
      return;
    }

    const res = saveRecordItems(record.id, cleaned);
    if (!res.success) {
      toast(res.error);
      if (res.locked) { discard(); if (onSaved) onSaved(); }
      return;
    }
    addedFiles.current = [];     // now referenced by the saved record
    stopEditing();
    toast(res.message);
    if (onSaved) onSaved();
  };

  /* ---------------- derived view data ---------------- */
  const items = editing ? draft.items : savedItems;

  // A stale selection (its items were deleted) falls back to "All".
  const opts = useMemo(() => getItemFilterOptions(items), [items]);
  const eff = {
    ...filters,
    type: filters.type !== 'All' && !opts.types.includes(filters.type) ? 'All' : filters.type,
    mode: filters.mode !== 'All' && !opts.modes.includes(filters.mode) ? 'All' : filters.mode,
    category:
      filters.category === '__none__'
        ? (opts.hasUncategorized ? '__none__' : 'All')
        : filters.category !== 'All' && !opts.categories.includes(filters.category) ? 'All' : filters.category
  };

  const active = !editing && isItemFilterActive(eff);   // editing always shows every item
  const visible = active ? items.filter((it) => itemMatchesFilter(it, eff, showCS)) : items;
  const subtotal = calculateDeduplicatedBudget(visible);
  const total = formatPesoExact(calculateDeduplicatedBudget(items));
  const extraCols = editing ? 1 : 0;
  // Criteria and Strategies are Draft-only columns and disappear once the PPMP is submitted, so every
  // spanning cell in the footer rows has to shrink with them. A fixed span leaves the Total Budget
  // amount sitting in the wrong (or an off-screen) column.
  const fullSpan = (showCS ? 18 : 16) + extraCols;

  return (
    <div className="db-entry-expand-inner">
      <Toolbar
        record={record} user={user}
        editing={editing} dirty={dirty} canEdit={canEdit} confirmingDiscard={confirmingDiscard}
        onView={onView} onPreview={onPreview} onDelete={onDelete} onSubmit={onSubmit} onPdf={onPdf} onXlsx={onXlsx}
        onEdit={startEdit} onAddItem={addItem} onBulkImport={() => setBulkOpen(true)} onCancel={requestCancel}
        onKeepEditing={() => setConfirmingDiscard(false)} onDiscard={discard} onSave={save}
      />
      {!editing && items.length >= 2 && (
        <FilterBar items={items} filters={eff} setFilters={setFilters} shown={visible.length} />
      )}

      <div className="excel-preview-sheet">
        <div className="excel-preview-banner">
          <img src="/images/header-banner.png" alt="DICT Header Banner" />
        </div>
        <h2>PROJECT PROCUREMENT MANAGEMENT PLAN (PPMP) NO. {record.ppmp_no || 'N/A'}</h2>
        <div className="excel-preview-checks">
          <span><span className="excel-check-box">{record.is_indicative === 'Indicative' ? 'X' : ''}</span> INDICATIVE</span>
          <span><span className="excel-check-box">{record.is_indicative === 'Final' ? 'X' : ''}</span> FINAL</span>
        </div>
        <div className="excel-preview-meta">
          <p>Fiscal Year : {record.fiscal_year || 'N/A'}</p>
          <p>End-User or Implementing Unit: {record.end_user || 'N/A'}</p>
        </div>

        <div className="excel-preview-table-wrap">
          <table className={`excel-preview-table${showCS ? '' : ' ep-hide-cs'}`}>
            <thead>
              <tr>
                <th rowSpan="3">Ref No.</th>
                <th colSpan={showCS ? 6 : 5}>PROCUREMENT PROJECT DETAILS</th>
                <th colSpan="5">PROJECTED TIMELINE (MM/YYYY)</th>
                <th colSpan="2">FUNDING DETAILS</th>
                <th rowSpan="2" className="ep-cs-col">PROCUREMENT STRATEGIES AND TOOLS</th>
                <th rowSpan="2">ATTACHED SUPPORTING DOCUMENTS</th>
                <th rowSpan="2">GENERAL REQUIREMENTS/MISCELLANEOUS/COMMON SUPPLIES AND EQUIPMENT</th>
                <th rowSpan="2">REMARKS</th>
                {editing && <th rowSpan="3">Remove</th>}
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
                {(() => {
                  let n = 0;
                  return Array.from({ length: 17 }, (_, i) => {
                    const isCS = CS_COLUMNS.includes(i + 1);
                    if (isCS && !showCS) return <th key={i} className="ep-cs-col" />;
                    n += 1;
                    return <th key={i} className={isCS ? 'ep-cs-col' : undefined}>Column {n}</th>;
                  });
                })()}
              </tr>
            </thead>
            <tbody>
              {editing ? (
                <>
                  {draft.items.map((it) => (
                    <EditableRow
                      key={it.id}
                      item={it}
                      messages={messagesFor(it)}
                      toast={toast}
                      onField={changeField}
                      onBlurField={blurField}
                      onToggleStrategy={toggleStrategy}
                      onRemove={removeItem}
                      onPickFiles={pickFiles}
                      onRemoveDoc={removeDoc}
                    />
                  ))}
                  <tr className="ep-add-row">
                    <td colSpan={18 + extraCols}>
                      <button type="button" className="ep-add-btn" onClick={addItem}>
                        <PlusIcon /> Add Item
                      </button>
                    </td>
                  </tr>
                </>
              ) : (
                items.map((it, idx) => {
                  if (!itemMatchesFilter(it, eff, showCS)) return null;
                  const needsDoc = !itemHasSupportingDocument(it) && showCS;
                  return (
                    <tr key={it.id ?? idx} className="ep-item-row">
                      <td>{it.reference_no || '—'}</td>
                      <td>{it.project_description || ''}</td>
                      <td>{it.project_type || ''}</td>
                      <td>{it.quantity_size || ''}</td>
                      <td>{it.mode || ''}</td>
                      <td>{it.pre_procurement || ''}</td>
                      <td className="ep-cs-col">{showCS ? (it.bid_evaluation_criteria || 'N/A') : ''}</td>
                      <td>{it.start_date || ''}</td>
                      <td>{it.bid_opening_date || ''}</td>
                      <td>{it.notice_of_award_date || ''}</td>
                      <td>{it.end_date || ''}</td>
                      <td>{it.delivery_period || ''}</td>
                      <td>{it.fund_source || ''}</td>
                      <td>{formatPesoExact(parseBudgetNumber(it.budget))}</td>
                      <td className="ep-cs-col" style={{ textAlign: 'center' }}>
                        {showCS ? <List values={it.strategies} /> : ''}
                      </td>
                      <td>
                        {needsDoc ? (
                          <span
                            className="ep-none ep-needs-doc"
                            title={`Required before this PPMP can be submitted: ${getRequiredDocLabel(it.project_type)}`}
                          >
                            Needs document
                          </span>
                        ) : <Docs item={it} toast={toast} />}
                      </td>
                      <td>{it.general_requirements || ''}</td>
                      <td>{it.remarks || ''}</td>
                    </tr>
                  );
                })
              )}

              {active && visible.length === 0 && (
                <tr className="ep-filter-empty">
                  <td colSpan={fullSpan}>No items match the current filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Totals sit outside the <table>: the first two table columns are sticky, and a footer row built from
            those columns made the amount slide underneath the TOTAL BUDGET label. */}
        <div
          className="ep-total-bar"
          style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'baseline', gap: '6px 28px', padding: '12px 14px 4px', fontWeight: 700 }}
        >
          {active && visible.length > 0 && (
            <span className="ep-filter-subtotal-label">
              FILTERED TOTAL ({visible.length} of {items.length} items):{' '}
              <span className="ep-filter-subtotal-value">{formatPesoExact(subtotal)}</span>
            </span>
          )}
          <span>TOTAL BUDGET: <span>{total}</span></span>
        </div>
      </div>

      {/* Rendered in <body> so the dialog is never clipped by the expanding table row. */}
      {bulkOpen && createPortal(
        <BulkImportModal
          isOpen={bulkOpen}
          onClose={() => setBulkOpen(false)}
          recordId={record.id}
          headerData={{
            ppmp_no: record.ppmp_no,
            fiscal_year: record.fiscal_year,
            end_user: record.end_user,
            is_indicative: record.is_indicative
          }}
          onSuccess={(res) => {
            if (onSaved) onSaved();
            toast(`${res.count} ${res.count === 1 ? 'item' : 'items'} added to PPMP No. ${res.ppmp_no}.` +
              (res.converted ? ` ${res.converted} switched to Two Failed Biddings.` : '') +
              ' Attach the supporting documents before submitting.');
          }}
        />,
        document.body
      )}
    </div>
  );
}