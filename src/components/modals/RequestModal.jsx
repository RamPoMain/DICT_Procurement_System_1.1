import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  parseBudgetNumber,
  STANDARD_PROCUREMENT_MODES,
  isBracketMismatch,
  exceedsModeCeiling,
  budgetBracketMessage,
  claimEntryRef,
  findExistingReferenceInfo,
  tagFailedAttempts,
  getRecordItems,
  getPpmpStatus,
  isPpmpDraft,
  isPpmpLocked,
  isPpmpReturned,
  canSessionActOnRecord,
  formatApprovalDate,
  formatApprovalDateTime,
  getApprovalStep,
  APPROVAL_CHAIN,
  getItemsMissingDocuments,
  getItemsBudgetModeMismatch,
  buildMissingDocsMessage,
  buildBudgetMismatchMessage,
  performPpmpReviewAction,
  isAppFinal,
  getAvailableFiscalYears,
  getNewRequestTarget,
  newRequestBlockedMessage as blockedMessage,
  carryOverItems,
  updatePriorFailedBiddingRemarks,
  normalizeDescription
} from '../../utils/procurementRules.js';
import { generatePPMP_PDF } from '../../utils/pdfGenerator.js';
import { downloadSignedDtmsFile, submitPpmpStageToDtms, submitPpmpViaDtms, syncAllWithDtms, testSendToDtms } from '../../utils/dtmsClient.js';
import { exportPPMP_Excel } from '../../utils/entriesExport.js';
import FileStore from '../../utils/fileStore.js';
import { getNextPpmpNumber } from '../../utils/ppmpNumber.js';
import {
  BID_CRITERIA_OPTIONS,
  STRATEGY_OPTIONS,
  GENERAL_REQUIREMENT_OPTIONS as GENERAL_REQ_OPTIONS,
  EXPENSE_CLASS_OPTIONS
} from '../../utils/procurementOptions.js';
import FilePreviewModal from './FilePreviewModal.jsx';
import { PpmpSheet, PreviewBoundary } from './ExcelPreviewModal.jsx';

// BID_CRITERIA_OPTIONS, STRATEGY_OPTIONS, GENERAL_REQ_OPTIONS and EXPENSE_CLASS_OPTIONS now live in
// utils/procurementOptions.js so the form and the Excel import always agree.
const PROJECT_TYPE_DOC_LABELS = {
  'Goods': 'Technical Specifications',
  'Consulting Services': 'Terms of Reference',
  'Infrastructure': 'Scope of Work'
};
const MAX_FILE_SIZE = 10 * 1024 * 1024;   // 10MB per file
const MAX_TOTAL_SIZE = 50 * 1024 * 1024;  // 50MB total per item
const formatFileSize = (b) => b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const STEP_PROGRESS = [15, 45, 85];

// Same matching rule the reference-number lookup uses (case-insensitive, ignores a "[1st Failure]" prefix),
// plus collapsed spaces, so "Laptops" and "laptops " are the same entry.
const normDesc = (s) => normalizeDescription(String(s || '').replace(/\s+/g, ' '));

// Default to the first fiscal year in the rolling list whose APP is not final.
function pickDefaultFiscalYear() {
  const years = getAvailableFiscalYears();
  return years.find((year) => !isAppFinal(year)) || years[years.length - 1];
}

export default function RequestModal({ isOpen, onClose, recordId = null, onSaved, onBulkImport }) {
  const { user } = useAuth();
  const [step, setStep] = useState(1);
  const [isViewMode, setIsViewMode] = useState(false);
  const [itemIdx, setItemIdx] = useState(0);

  const [headerData, setHeaderData] = useState(() => ({
    ppmp_no: '',
    fiscal_year: pickDefaultFiscalYear(),
    end_user: user?.office || '',
    is_indicative: 'Indicative'
  }));

  const [items, setItems] = useState([]);
  const [activeItem, setActiveItem] = useState(createBlankItem());
  const [errors, setErrors] = useState({});
  const [failedBiddingWarning, setFailedBiddingWarning] = useState('');
  const [failedBiddingInfo, setFailedBiddingInfo] = useState('');
  const [stratOpen, setStratOpen] = useState(false);
  const [recordStatus, setRecordStatus] = useState('Draft');
  const [currentRecord, setCurrentRecord] = useState(null);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [reviewRemarks, setReviewRemarks] = useState('');
  const [reviewRemarksError, setReviewRemarksError] = useState(false);
  const [stageSubmitting, setStageSubmitting] = useState(false);
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);
  const [dtmsTestDialogOpen, setDtmsTestDialogOpen] = useState(false);
  const [dtmsTesting, setDtmsTesting] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewDoc, setPreviewDoc] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const [descFocused, setDescFocused] = useState(false);
  // Last object code that was filled in automatically (so we never overwrite one the user typed).
  const autoCodeRef = useRef(null);

  function createBlankItem() {
    return {
      id: Date.now(),
      project_description: '',
      object_name: '',
      project_type: '',
      mode: '',
      pre_procurement: '',
      bid_evaluation_criteria: '',
      quantity_size: '',
      start_date: '',
      bid_opening_date: '',
      notice_of_award_date: '',
      end_date: '',
      delivery_period: '',
      fund_source: '',
      budget: '',
      expense_class: 'N/A',
      strategies: [],
      remarks: '',
      general_requirements: '',
      supporting_documents: []
    };
  }

  // Next PPMP number for this office + fiscal year (shown read-only on a new request)
  function nextPpmpNo(fy) {
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    return getNextPpmpNumber(all, user?.office, fy);
  }

  useEffect(() => {
    if (!isOpen) return;
    setStep(1);
    setStratOpen(false);
    setErrors({});
    setNotice('');
    setConfirmDelete(false);
    setReviewDialogOpen(false);
    setSubmitDialogOpen(false);
    setDtmsTestDialogOpen(false);
    setReviewRemarks('');
    setReviewRemarksError(false);
    setRecordStatus('Draft');
    setFailedBiddingWarning('');
    setFailedBiddingInfo('');

    if (recordId) {
      const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
      const rec = records.find(r => r.id === recordId);
      if (rec) {
        setCurrentRecord(rec);
        setHeaderData({
          ppmp_no: rec.ppmp_no,
          fiscal_year: rec.fiscal_year,
          end_user: rec.end_user,
          is_indicative: rec.is_indicative
        });
        const itms = getRecordItems(rec);
        setItems(itms);
        setItemIdx(0);
        setActiveItem(itms[0] || createBlankItem());
        setIsViewMode(true);
        setRecordStatus(rec.status || 'Draft');
      } else {
        setCurrentRecord(null);
      }
    } else {
      setCurrentRecord(null);
      setIsViewMode(false);
      const defaultFy = pickDefaultFiscalYear();
      const fresh = createBlankItem();
      setItems([fresh]);
      setItemIdx(0);
      setActiveItem(fresh);
      setHeaderData({
        ppmp_no: nextPpmpNo(defaultFy),
        fiscal_year: defaultFy,
        end_user: user?.office || '',
        is_indicative: 'Indicative'
      });
      setRecordStatus('Draft');
    }
  }, [isOpen, recordId]);

  useEffect(() => {
    if (!isOpen || !recordId) return undefined;
    let active = true;
    const sync = async () => {
      try {
        await syncAllWithDtms();
      } catch (error) {
        if (active) setNotice(`DTMS sync issue: ${error.message}`);
      }
    };
    const syncWhenVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    sync();
    const syncTimer = setInterval(sync, 45000);
    document.addEventListener('visibilitychange', syncWhenVisible);
    window.addEventListener('focus', syncWhenVisible);
    const timer = setInterval(() => {
      const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
      const record = records.find((item) => item.id === recordId);
      if (record) {
        setCurrentRecord(record);
        setRecordStatus(record.status || 'Draft');
      }
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
      clearInterval(syncTimer);
      document.removeEventListener('visibilitychange', syncWhenVisible);
      window.removeEventListener('focus', syncWhenVisible);
    };
  }, [isOpen, recordId]);

  // Live detection of Two Failed Biddings under RA 12009 Sec. 33 and linking of re-bids
  useEffect(() => {
    if (isViewMode) {
      setFailedBiddingWarning('');
      setFailedBiddingInfo('');
      return;
    }
    const desc = activeItem.project_description?.trim();
    if (!desc) {
      setFailedBiddingWarning('');
      setFailedBiddingInfo('');
      return;
    }
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const currentRec = recordId ? all.find(r => r.id === recordId) : null;
    const refInfo = findExistingReferenceInfo(desc, activeItem.project_type, currentRec, user?.office);

    if (refInfo && refInfo.competitiveCount >= 2) {
      setActiveItem(prev => ({
        ...prev,
        mode: 'Negotiated Procurement – Two Failed Biddings',
        bid_evaluation_criteria: 'Negotiated'
      }));
      setFailedBiddingWarning(`Matches ${refInfo.reference_no || 'prior attempts'}: 2 failed biddings detected. Mode is locked to Negotiated Procurement – Two Failed Biddings.`);
      setFailedBiddingInfo('');
    } else if (refInfo && refInfo.reference_no) {
      setFailedBiddingWarning('');
      const attemptNum = (refInfo.competitiveCount || 0) + 1;
      setFailedBiddingInfo(`Linked to existing reference: ${refInfo.reference_no} (Attempt #${attemptNum})`);
      setActiveItem(prev => {
        if (prev.mode?.includes('Two Failed Biddings')) {
          return {
            ...prev,
            mode: '',
            bid_evaluation_criteria: prev.bid_evaluation_criteria === 'Negotiated' ? '' : prev.bid_evaluation_criteria
          };
        }
        return prev;
      });
    } else {
      setFailedBiddingWarning('');
      setFailedBiddingInfo('');
      setActiveItem(prev => {
        if (prev.mode?.includes('Two Failed Biddings')) {
          return {
            ...prev,
            mode: '',
            bid_evaluation_criteria: prev.bid_evaluation_criteria === 'Negotiated' ? '' : prev.bid_evaluation_criteria
          };
        }
        return prev;
      });
    }
  }, [activeItem.project_description, activeItem.project_type, isViewMode, recordId, user?.office]);

  // Auto-hide the small toast message
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  if (!isOpen) return null;

  // Rolling fiscal years: two open years at a time; a final APP adds the next two years.
  // Also preserve the year of an older PPMP when editing.
  const thisYear = new Date().getFullYear();
  const yearOptions = [...new Set([
    ...getAvailableFiscalYears(thisYear).map(Number),
    ...(recordId && currentRecord?.fiscal_year ? [Number(currentRecord.fiscal_year)] : [])
  ])].sort((a, b) => a - b).map(String);
  // A closed year (final APP) is shown but cannot be picked, unless this PPMP already lives in it.
  const isYearLocked = (year) =>
    isAppFinal(year) && !(recordId && String(currentRecord?.fiscal_year) === year);

  // Closed = that year's APP is already final. A PPMP that already lives in that year can keep it;
  // a new PPMP (or an existing one being moved into it) cannot.
  const fiscalYearIsClosed =
    !!headerData.fiscal_year &&
    isAppFinal(String(headerData.fiscal_year)) &&
    (!recordId || String(headerData.fiscal_year) !== String(currentRecord?.fiscal_year));

  const newTarget = !recordId
    ? (() => {
        let all = [];
        try { all = JSON.parse(localStorage.getItem('procurement_records')) || []; } catch { all = []; }
        return getNewRequestTarget(all, user?.office, headerData.fiscal_year);
      })()
    : null;

  const closedYearMessage = `The APP for FY ${headerData.fiscal_year} is already final, so a new PPMP cannot be created under it. Choose another fiscal year.`;

  const validateCurrentStep = () => {
    const errs = {};
    if (step === 1) {
      const fiscalYear = String(headerData.fiscal_year || '').trim();
      if (!yearOptions.includes(fiscalYear)) errs.fiscal_year = 'Select a fiscal year from the available options.';
      else if (fiscalYearIsClosed) errs.fiscal_year = closedYearMessage;
      else if (newTarget?.mode === 'blocked') errs.fiscal_year = blockedMessage(newTarget.record, headerData.fiscal_year);
      if (!activeItem.project_description) errs.project_description = 'Description is required';
      if (!activeItem.object_name || !/^\d+$/.test(activeItem.object_name)) errs.object_name = 'Object Code must be numbers only';
      if (!activeItem.project_type) errs.project_type = 'Select a Project Type';
      if (!activeItem.mode) errs.mode = 'Select a Procurement Mode';
      if (!activeItem.quantity_size) errs.quantity_size = 'Quantity and size required';
      if (!activeItem.pre_procurement) errs.pre_procurement = 'This field is required.';
      if (!activeItem.bid_evaluation_criteria) errs.bid_evaluation_criteria = 'This field is required.';

      // Shopping / Repeat Order Goods check
      if (['Shopping', 'Repeat Order'].includes(activeItem.mode) && activeItem.project_type !== 'Goods') {
        errs.mode = `${activeItem.mode} is strictly for Goods (RA 12009)`;
      }
    }
    if (step === 2) {
      const dates = [
        { key: 'start_date', label: 'Advertisement/Posting' },
        { key: 'bid_opening_date', label: 'Bid Opening' },
        { key: 'notice_of_award_date', label: 'Notice of Award' },
        { key: 'end_date', label: 'Contract Signing' },
        { key: 'delivery_period', label: 'Delivery Period' }
      ];
      dates.forEach(d => { if (!activeItem[d.key]) errs[d.key] = `${d.label} is required`; });

      // Chronological sequence validation
      if (activeItem.start_date && activeItem.bid_opening_date && activeItem.bid_opening_date < activeItem.start_date) {
        errs.bid_opening_date = 'Bid Opening cannot be before Advertisement/Posting';
      }
      if (activeItem.bid_opening_date && activeItem.notice_of_award_date && activeItem.notice_of_award_date < activeItem.bid_opening_date) {
        errs.notice_of_award_date = 'Notice of Award cannot be before Bid Opening';
      }
      if (activeItem.notice_of_award_date && activeItem.end_date && activeItem.end_date < activeItem.notice_of_award_date) {
        errs.end_date = 'Contract Signing cannot be before Notice of Award';
      }
      if (activeItem.end_date && activeItem.delivery_period && activeItem.delivery_period <= activeItem.end_date) {
        errs.delivery_period = 'Delivery Period must be strictly after Contract Signing';
      }

      // Funding (these fields moved to step 2 to match the original form)
      if (!activeItem.fund_source) errs.fund_source = 'This field is required.';
      const b = parseBudgetNumber(activeItem.budget);
      if (!b || b <= 0) {
        errs.budget = 'Budget must be greater than 0';
      } else if (!activeItem.mode?.includes('Two Failed Biddings') && activeItem.mode !== 'Negotiated Procurement') {
        if (isBracketMismatch(activeItem.mode, b)) errs.budget = budgetBracketMessage(activeItem.mode, b);
        else if (exceedsModeCeiling(activeItem.mode, b)) errs.budget = `Exceeds allowable budget for ${activeItem.mode}`;
      }
      if (!EXPENSE_CLASS_OPTIONS.includes(activeItem.expense_class)) {
        errs.expense_class = 'Please select whether the budget is MOOE, CO, or N/A.';
      }
    }
    if (step === 3) {
      if (!activeItem.strategies?.length) errs.strategies = 'Please select at least one procurement strategy.';
      if (!activeItem.remarks?.trim()) errs.remarks = 'This field is required.';
      if (!activeItem.supporting_documents?.length) errs.supporting_documents = 'Please upload at least one supporting document.';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleNext = () => {
    if (validateCurrentStep()) setStep(s => s + 1);
  };

  const switchItem = (targetIdx) => {
    if (targetIdx < 0 || targetIdx >= items.length || targetIdx === itemIdx) return;
    const updated = [...items];
    updated[itemIdx] = { ...activeItem };
    setItems(updated);
    setItemIdx(targetIdx);
    setActiveItem(updated[targetIdx]);
    setStep(1);
    setErrors({});
  };

  const switchItemView = (targetIdx) => {
    if (targetIdx < 0 || targetIdx >= items.length || targetIdx === itemIdx) return;
    setItemIdx(targetIdx);
    setActiveItem(items[targetIdx]);
    setStep(1);
  };

  const handleAddNewItem = () => {
    const updated = [...items];
    updated[itemIdx] = { ...activeItem };
    const fresh = createBlankItem();
    updated.push(fresh);
    setItems(updated);
    setItemIdx(updated.length - 1);
    setActiveItem(fresh);
    setStep(1);
    setErrors({});
    setNotice(`Item ${updated.length} of ${updated.length} added.`);
  };

  const handleDeleteItemInForm = () => {
    if (items.length <= 1) {
      setConfirmDelete(true);
      return;
    }
    const remaining = items.filter((_, i) => i !== itemIdx);
    const nextIdx = Math.min(itemIdx, remaining.length - 1);
    setItems(remaining);
    setItemIdx(nextIdx);
    setActiveItem(remaining[nextIdx]);
    setStep(1);
    setErrors({});
    setNotice('Item removed from PPMP.');
  };

  const handleSave = () => {
    if (fiscalYearIsClosed) {
      setStep(1);
      setErrors({ fiscal_year: closedYearMessage });
      return;
    }
    if (!validateCurrentStep()) return;
    let records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const updatedItems = [...items];
    const finalItem = { ...activeItem };

    const currentRec = recordId ? records.find(r => r.id === recordId) : null;
    const refInfo = findExistingReferenceInfo(
      finalItem.project_description,
      finalItem.project_type,
      currentRec,
      user?.office
    );

    const isTwoFailed = finalItem.mode?.includes('Two Failed Biddings') || (refInfo && refInfo.competitiveCount >= 2);

    if (refInfo?.reference_no) {
      finalItem.reference_no = refInfo.reference_no;
    } else if (!finalItem.reference_no) {
      finalItem.reference_no = claimEntryRef(records, finalItem.project_type, headerData.fiscal_year);
    }

    if (isTwoFailed) {
      finalItem.mode = 'Negotiated Procurement – Two Failed Biddings';
      finalItem.bid_evaluation_criteria = 'Negotiated';
      const autoRemark = '[Negotiated Procurement – Two Failed Biddings (RA 12009 Sec. 33)]';
      if (!String(finalItem.remarks || '').toLowerCase().includes('two failed biddings')) {
        finalItem.remarks = finalItem.remarks ? `${finalItem.remarks.trim()} ${autoRemark}` : autoRemark;
      }
    }

    updatedItems[itemIdx] = finalItem;

    // Same description = same procurement. Link every such item under ONE reference number so
    // totals (which de-duplicate by reference_no) count its budget once, not once per entry.
    updatedItems.forEach((it, i) => {
      if (i === itemIdx || it.reference_no) return;
      const info = findExistingReferenceInfo(it.project_description, it.project_type, currentRec, user?.office);
      if (info?.reference_no) updatedItems[i] = { ...it, reference_no: info.reference_no };
    });
    const entryKey = (it) => normDesc(it.project_description);
    const refByEntry = new Map();
    updatedItems.forEach((it) => {
      if (it.reference_no && normDesc(it.project_description)) refByEntry.set(entryKey(it), it.reference_no);
    });
    updatedItems.forEach((it, i) => {
      const ref = !it.reference_no && refByEntry.get(entryKey(it));
      if (ref) updatedItems[i] = { ...it, reference_no: ref };
    });

    if (recordId) {
      const idx = records.findIndex(r => r.id === recordId);
      if (idx !== -1 && getPpmpStatus(records[idx]) !== 'Draft') {
        window.alert('This PPMP was submitted or approved in the meantime, so it can no longer be changed.');
        if (onSaved) onSaved();
        onClose();
        return;
      }
      if (idx !== -1) {
        records[idx].items = updatedItems;
        records[idx].fiscal_year = headerData.fiscal_year;
        records[idx].is_indicative = headerData.is_indicative;
      }
    } else {
      const target = getNewRequestTarget(records, user.office, headerData.fiscal_year);

      if (target.mode === 'blocked') {
        setStep(1);
        setErrors({ fiscal_year: blockedMessage(target.record, headerData.fiscal_year) });
        return;
      }

      if (target.mode === 'append') {
        // Latest PPMP is still a Draft: the new item becomes another entry in it.
        const idx = records.findIndex(r => r.id === target.record.id);
        records[idx].items = [...getRecordItems(records[idx]), ...updatedItems];
      } else {
        // No PPMP yet, or the latest one is approved: create the next PPMP. An approved one is carried
        // over in full, followed by the item(s) entered here.
        const carried = target.mode === 'new-version' ? carryOverItems(target.record) : [];
        const newRec = {
          id: Date.now(),
          ppmp_no: getNextPpmpNumber(records, user.office, headerData.fiscal_year),
          fiscal_year: headerData.fiscal_year,
          end_user: user.office,
          is_indicative: headerData.is_indicative,
          status: 'Draft',
          items: [...carried, ...updatedItems],
          remarksHistory: []
        };
        records.push(newRec);
      }
    }

    // Always update prior failed bidding remarks and tags if this is a re-bid
    if (finalItem.reference_no) {
      records = updatePriorFailedBiddingRemarks(records, finalItem.reference_no);
    }
    if (isTwoFailed) {
      records = tagFailedAttempts(records, finalItem.project_description, user?.office);
    }

    localStorage.setItem('procurement_records', JSON.stringify(records));
    if (onSaved) onSaved();
    onClose();
  };

  // Every entry this office has already made (saved PPMPs + the other items in this form),
  // keyed by description. Used to reuse the object code and to fill the suggestion dropdown.
  const getKnownEntries = () => {
    let all = [];
    try { all = JSON.parse(localStorage.getItem('procurement_records')) || []; } catch { all = []; }
    const map = new Map();
    const add = (it) => {
      const key = normDesc(it?.project_description);
      if (!key || it.id === activeItem.id) return;
      const prev = map.get(key);
      map.set(key, {
        description: String(it.project_description).trim(),
        object_name: prev?.object_name || it.object_name || '',
        project_type: it.project_type || prev?.project_type || ''
      });
    };
    all
      .filter(r => !user?.office || r.end_user === user.office)
      .forEach(r => getRecordItems(r).forEach(add));
    items.forEach((it, i) => { if (i !== itemIdx) add(it); });
    return map;
  };

  // Typing a description that matches an earlier entry copies its object code by default.
  // The code stays editable, and one the user typed themselves is never overwritten.
  const applyDescription = (value) => {
    const next = { ...activeItem, project_description: value };
    const match = getKnownEntries().get(normDesc(value));
    const mayAuto = !activeItem.object_name || activeItem.object_name === autoCodeRef.current;
    if (mayAuto) {
      if (match?.object_name) {
        next.object_name = match.object_name;
        autoCodeRef.current = match.object_name;
        clearError('object_name');
      } else if (activeItem.object_name) {
        next.object_name = '';
        autoCodeRef.current = null;
      }
    }
    setActiveItem(next);
  };

  const pickSuggestion = (entry) => {
    const next = { ...activeItem, project_description: entry.description };
    if (entry.object_name) {
      next.object_name = entry.object_name;
      autoCodeRef.current = entry.object_name;
      clearError('object_name');
    }
    if (!activeItem.project_type && entry.project_type) next.project_type = entry.project_type;
    setActiveItem(next);
    clearError('project_description');
    setDescFocused(false);
  };

  const clearError = (key) => setErrors(e => { const { [key]: _removed, ...rest } = e; return rest; });

  const addFiles = async (fileList) => {
    const incoming = Array.from(fileList || []);
    let total = (activeItem.supporting_documents || []).reduce((s, d) => s + (d.size || 0), 0);
    for (const file of incoming) {
      if (file.size > MAX_FILE_SIZE) {
        setErrors(e => ({ ...e, supporting_documents: `"${file.name}" is ${formatFileSize(file.size)}, which is over the ${formatFileSize(MAX_FILE_SIZE)} per-file limit. Please attach a smaller file.` }));
        continue;
      }
      if (total + file.size > MAX_TOTAL_SIZE) {
        setErrors(e => ({ ...e, supporting_documents: `Adding "${file.name}" would exceed the ${formatFileSize(MAX_TOTAL_SIZE)} total attachment limit for this request.` }));
        continue;
      }
      try {
        const fileId = FileStore.newId();
        await FileStore.put(fileId, file);
        total += file.size;
        clearError('supporting_documents');
        setActiveItem(prev => ({
          ...prev,
          supporting_documents: [...prev.supporting_documents, { name: file.name, size: file.size, type: file.type, fileId }]
        }));
      } catch {
        setErrors(e => ({ ...e, supporting_documents: `The file "${file.name}" could not be stored in this browser (storage may be full).` }));
      }
    }
  };

  const removeDoc = (idx) => {
    setActiveItem(prev => ({ ...prev, supporting_documents: prev.supporting_documents.filter((_, i) => i !== idx) }));
  };

  const downloadDoc = async (d) => {
    try {
      const blob = await FileStore.docBlob(d);
      if (!blob) {
        setNotice('File data not found in storage.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.name || 'document';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setNotice('Could not download file.');
    }
  };

  // Selecting N/A clears every other strategy; picking a real one clears N/A (as in the original form)
  const toggleStrategy = (s) => {
    const cur = activeItem.strategies || [];
    let next;
    if (s === 'N/A') next = cur.includes('N/A') ? [] : ['N/A'];
    else {
      const base = cur.filter(x => x !== 'N/A');
      next = base.includes(s) ? base.filter(x => x !== s) : [...base, s];
    }
    setActiveItem({ ...activeItem, strategies: next });
    if (next.length) clearError('strategies');
  };

  const dateField = (key, label) => (
  <div className={`field-group ${errors[key] ? 'error-state' : ''}`}>
    <label>{label}</label>
    <input
      type="date"
      value={activeItem[key]}
      disabled={isViewMode}
      onChange={e => setActiveItem({ ...activeItem, [key]: e.target.value })}
      onClick={e => {
        if (isViewMode) return;
        try { e.currentTarget.showPicker(); } catch { /* browser doesn't support it */ }
      }}
    />
    {errors[key] && <p className="text-45">{errors[key]}</p>}
  </div>
);

  // Only requesters can edit, and only while the PPMP is still a Draft
  const canAct = !!currentRecord && canSessionActOnRecord(currentRecord, user);
  const isDraft = !currentRecord || isPpmpDraft(currentRecord);
  const isReturned = !!currentRecord && isPpmpReturned(currentRecord);
  const canEdit = !!recordId && isDraft && !!user?.canRequest;

  const enableEditMode = () => {
    if (!user?.canRequest) { setNotice('Your account is view/approve only and cannot edit requests.'); return; }
    if (currentRecord && isPpmpLocked(currentRecord)) {
      setNotice('This PPMP is submitted for approval or approved — it can no longer be edited.');
      return;
    }
    setIsViewMode(false);
    setNotice('You can now edit this request.');
  };

  const handleOpenSubmitDialog = () => {
    if (!currentRecord) return;
    const missingDocs = getItemsMissingDocuments(currentRecord);
    if (missingDocs.length > 0) {
      setNotice(buildMissingDocsMessage(missingDocs));
      return;
    }
    const modeMismatch = getItemsBudgetModeMismatch(currentRecord);
    if (modeMismatch.length > 0) {
      setNotice(buildBudgetMismatchMessage(modeMismatch));
      return;
    }
    setSubmitDialogOpen(true);
  };

  const handleConfirmSubmit = async () => {
    if (!currentRecord) return;
    setSubmitDialogOpen(false);
    try {
      // Validate, send to DTMS and mark For Approval in one step (see submitPpmpViaDtms).
      const res = await submitPpmpViaDtms(currentRecord.id, user);
      if (!res.success) { setNotice(res.error); return; }
      setNotice(res.message);
      setCurrentRecord({ ...res.record });
      setRecordStatus(res.record.status);
      if (onSaved) onSaved();
    } catch (e) {
      setNotice(e.message);
    }
  };

  const handleConfirmDtmsTest = async () => {
    if (!currentRecord || dtmsTesting) return;
    setDtmsTestDialogOpen(false);
    setDtmsTesting(true);
    try {
      const result = await testSendToDtms('PPMP', currentRecord, user);
      setNotice(`DTMS test document sent. Tracking no. ${result.tracknumber}`);
    } catch (e) {
      setNotice(`DTMS test send failed: ${e.message}`);
    } finally {
      setDtmsTesting(false);
    }
  };

  const handleReviewAction = async (action) => {
    if (!currentRecord || stageSubmitting) return;
    const remarks = reviewRemarks.trim();
    if ((action === 'reject' || action === 'comment') && !remarks) {
      setReviewRemarksError(true);
      return;
    }
    if (action === 'approve' && ['TOD', 'BO'].includes(user?.stage) && currentRecord.dtms_track) {
      setStageSubmitting(true);
      try {
        const result = await submitPpmpStageToDtms(currentRecord.id, user, remarks);
        if (!result.success) {
          setNotice(result.error);
          return;
        }
        setReviewDialogOpen(false);
        setReviewRemarks('');
        setReviewRemarksError(false);
        setCurrentRecord({ ...result.record });
        setNotice(result.message);
        if (onSaved) onSaved();
      } catch (error) {
        setNotice(`Could not send this PPMP to DTMS: ${error.message}`);
      } finally {
        setStageSubmitting(false);
      }
      return;
    }
    const res = performPpmpReviewAction(currentRecord.id, action, remarks, user);
    if (!res.success) {
      setNotice(res.error);
      return;
    }
    setReviewDialogOpen(false);
    setReviewRemarks('');
    setReviewRemarksError(false);
    setNotice(res.message);
    if (onSaved) onSaved();

    if (action === 'comment') {
      setCurrentRecord({ ...res.record });
    } else {
      onClose();
    }
  };

  const deleteCurrentItem = () => {
    const records = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const idx = records.findIndex(r => r.id === recordId);
    if (idx === -1) return;
    if (getPpmpStatus(records[idx]) !== 'Draft') {
      setConfirmDelete(false);
      setNotice('This PPMP is submitted for approval or approved - items can no longer be deleted.');
      return;
    }
    const remaining = getRecordItems(records[idx]).filter((_, i) => i !== itemIdx);
    if (remaining.length === 0) records.splice(idx, 1);   // last item: remove the whole PPMP
    else records[idx].items = remaining;
    localStorage.setItem('procurement_records', JSON.stringify(records));
    setConfirmDelete(false);
    if (onSaved) onSaved();
    onClose();
  };

  const exportPpmp = () => {
    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
    const rec = all.find(r => r.id === recordId);
    if (rec) generatePPMP_PDF(rec);
  };

  const docLabel = PROJECT_TYPE_DOC_LABELS[activeItem.project_type];
  const docs = activeItem.supporting_documents || [];

  const typedDesc = normDesc(activeItem.project_description);
  const descSuggestions = (descFocused && !isViewMode)
    ? [...getKnownEntries().values()]
        .filter(e => normDesc(e.description) !== typedDesc && normDesc(e.description).includes(typedDesc))
        .slice(0, 6)
    : [];

  return (
    <div className="db-modal-overlay" id="requestModalOverlay">
      <div className="db-modal">
        <div className="db-modal-header-actions">
          {!recordId && onBulkImport && (
            <button
              type="button"
              className="db-modal-pdf-btn"
              onClick={() => onBulkImport(headerData)}
            >
              &#8593; Bulk import
            </button>
          )}

          {canAct && (
            <button
              type="button"
              className="db-modal-pdf-btn"
              style={{
                background: 'var(--db-accent, #3b82f6)',
                color: '#fff',
                borderColor: 'var(--db-accent, #3b82f6)',
                fontWeight: 600
              }}
              onClick={() => {
                setReviewRemarks('');
                setReviewRemarksError(false);
                setReviewDialogOpen(true);
              }}
            >
              Review PPMP
            </button>
          )}

          {recordId && isViewMode && isDraft && user?.canRequest && (
            <button
              type="button"
              className="db-modal-pdf-btn"
              style={{
                background: 'var(--db-green, #10b981)',
                color: '#fff',
                borderColor: 'var(--db-green, #10b981)',
                fontWeight: 600
              }}
              onClick={handleOpenSubmitDialog}
            >
              Submit for Approval &rarr;
            </button>
          )}

          {recordId && isViewMode && canEdit && (
            <>
              <button type="button" className="db-modal-edit-item-btn" onClick={enableEditMode}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                Edit
              </button>
              <button type="button" className="db-modal-delete-item-btn" onClick={() => setConfirmDelete(true)}>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
                Delete Item
              </button>
            </>
          )}
        </div>
        <button type="button" className="db-modal-close" onClick={onClose}>&times;</button>

        <div className="title-tab-wrapper">
          <span className="text-9">
            {canAct ? `APPROVAL REQUIRED: PPMP NO. ${headerData.ppmp_no || ''}` : (
              step === 1 ? 'PROCUREMENT PROJECT DETAILS' :
              step === 2 ? 'PROJECTED TIMELINE' :
              'FUNDING DETAILS'
            )}
          </span>
          {recordId && (
            <span className={`modal-status-badge ${
              isReturned ? 'is-returned' :
              recordStatus === 'Completed' ? 'is-completed' :
              recordStatus === 'For Approval' ? 'is-pending' : 'is-draft'
            }`}>
              {isReturned ? 'Returned' : (recordStatus === 'Completed' || recordStatus === 'For Approval' ? recordStatus : 'Draft')}
            </span>
          )}
        </div>

        {/* Multi-Item Navigator & Item Actions */}
        {(items.length > 1 || !isViewMode) && (
          <div className="modal-item-nav-container">
            <div className="modal-item-nav-controls">
              <button
                type="button"
                className="modal-item-nav-btn"
                disabled={itemIdx === 0}
                onClick={() => isViewMode ? switchItemView(itemIdx - 1) : switchItem(itemIdx - 1)}
                title="Previous Item"
              >
                &larr;
              </button>
              <span className="modal-item-nav-counter">
                Item {itemIdx + 1} of {items.length}
              </span>
              <button
                type="button"
                className="modal-item-nav-btn"
                disabled={itemIdx === items.length - 1}
                onClick={() => isViewMode ? switchItemView(itemIdx + 1) : switchItem(itemIdx + 1)}
                title="Next Item"
              >
                &rarr;
              </button>
              {activeItem?.origin_id && (
                <span className="modal-item-badge-carried">
                  Carried Over
                </span>
              )}
              {activeItem?.reference_no && (
                <span className="modal-item-badge-ref">
                  Ref: {activeItem.reference_no}
                </span>
              )}
            </div>

            {!isViewMode && (
              <div className="modal-item-nav-actions">
                <button
                  type="button"
                  onClick={handleAddNewItem}
                  className="modal-item-nav-add-btn"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Add Item
                </button>
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={handleDeleteItemInForm}
                    className="modal-item-nav-delete-btn"
                    title="Remove this item from request"
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></svg>
                    Delete Item
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {newTarget && newTarget.mode !== 'new' && (
          <div className="approval-info">
            {newTarget.mode === 'append' && (
              <>
                <strong>Adding to Draft PPMP No. {newTarget.record.ppmp_no}</strong>
                <span>This will be saved as a new entry in the existing Draft for FY {headerData.fiscal_year} instead of creating a new PPMP.</span>
              </>
            )}
            {newTarget.mode === 'new-version' && (
              <>
                <strong>PPMP No. {newTarget.record.ppmp_no} is approved</strong>
                <span>
                  Saving creates PPMP No. {headerData.ppmp_no} and carries over the {getRecordItems(newTarget.record).length}{' '}
                  {getRecordItems(newTarget.record).length === 1 ? 'item' : 'items'} from No. {newTarget.record.ppmp_no}, plus this new entry.
                </span>
              </>
            )}
            {newTarget.mode === 'blocked' && (
              <>
                <strong>PPMP No. {newTarget.record.ppmp_no} is under review</strong>
                <span>Nothing new can be added until it is approved or returned.</span>
              </>
            )}
          </div>
        )}

        {/* 1. Approval Info Banner if Completed */}
        {currentRecord && currentRecord.status === 'Completed' && (
          <div className="approval-info">
            <strong>Approved by {currentRecord.approved_by?.name || 'Regional Director'}</strong>
            <span>Approved on {formatApprovalDateTime(currentRecord.approved_at) || formatApprovalDate(currentRecord.approved_at)}</span>
          </div>
        )}

        {/* 2. Returned for revision banner */}
        {currentRecord && isReturned && (
          <div className="review-returned">
            <strong>Returned for revision by {currentRecord.rejected_by?.name || 'an approver'}</strong>
            {(() => {
              const history = Array.isArray(currentRecord.remarksHistory) ? currentRecord.remarksHistory : [];
              const lastRejection = history.slice().reverse().find(h => h.action === 'rejected');
              return lastRejection?.remarks ? <span>{lastRejection.remarks}</span> : null;
            })()}
            <small>
              Edit the PPMP, then submit it for approval again.
              {currentRecord.rejected_at ? ` \u00b7 ${formatApprovalDateTime(currentRecord.rejected_at)}` : ''}
            </small>
          </div>
        )}

        {/* 3. For Approval stage badge/banner */}
        {currentRecord && currentRecord.status === 'For Approval' && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderRadius: 9,
            background: 'rgba(59, 130, 246, 0.08)',
            border: '1px solid rgba(59, 130, 246, 0.25)',
            marginBottom: 16,
            fontSize: 12.5,
            color: 'var(--db-text)'
          }}>
            <span style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--db-accent, #3b82f6)',
              display: 'inline-block'
            }} />
            <strong>Currently with:</strong>
            <span>{getApprovalStep(currentRecord.currentApproverRole)?.label || currentRecord.currentApproverRole}</span>
          </div>
        )}

        {currentRecord?.dtms_signed_file_id && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <button
              type="button"
              className="app-preview-btn"
              onClick={() => setPreviewDoc({
                fileId: currentRecord.dtms_signed_file_id,
                name: currentRecord.dtms_signed_file_name || `PPMP_${currentRecord.ppmp_no}_signed.pdf`,
                type: 'application/pdf'
              })}
            >
              View signed DTMS PDF
            </button>
            <button
              type="button"
              className="app-preview-btn is-secondary"
              onClick={() => downloadSignedDtmsFile(currentRecord).catch((e) => setNotice(e.message))}
            >
              Download signed PDF
            </button>
          </div>
        )}

        {/* 4. Review History Audit Trail */}
        {currentRecord && Array.isArray(currentRecord.remarksHistory) && currentRecord.remarksHistory.length > 0 && (
          <div className="review-remarks" style={{ marginBottom: 20 }}>
            <p className="review-history-title">Review history</p>
            <ul className="review-list">
              {currentRecord.remarksHistory.map((h, idx) => {
                const action = h.action || 'approved';
                const stepInfo = getApprovalStep(h.stage);
                const stageLabel = stepInfo ? stepInfo.label : (h.stage || 'Approver');
                return (
                  <li key={idx} className="review-item">
                    <div className="review-item-head">
                      <span className={`review-tag is-${action}`}>
                        {action === 'approved' ? 'Approved' : action === 'rejected' ? 'Rejected' : action === 'remark' ? 'Remark' : 'Submitted'}
                      </span>
                      <strong>{h.name || h.role || 'Approver'}</strong>
                      <span>{[stageLabel, formatApprovalDateTime(h.at) || h.date].filter(Boolean).join(' \u00b7 ')}</span>
                    </div>
                    {h.remarks && user?.role !== 'SUP' && (
                      <p className="review-item-text">{h.remarks}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="track-4" style={{ maxWidth: 520, margin: '0 auto 22px' }}>
          <div className="filled-5" style={{ width: `${STEP_PROGRESS[step - 1]}%` }} />
        </div>

        {failedBiddingWarning && (
          <div className="failed-bidding-warning-box">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span>{failedBiddingWarning}</span>
          </div>
        )}

        {failedBiddingInfo && !failedBiddingWarning && (
          <div className="failed-bidding-info-box">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <span>{failedBiddingInfo}</span>
          </div>
        )}

        {step === 1 && (
          <div className="form-grid">
            {/* LEFT COLUMN */}
            <div className="form-col">
              <div className="field-group">
                <label>PPMP Number</label>
                <input type="text" value={newTarget?.mode === 'append' ? newTarget.record.ppmp_no : headerData.ppmp_no} readOnly />
              </div>

              <div className={`field-group ${errors.project_description ? 'error-state' : ''}`}>
                <label>General Description and Objective</label>
                <div style={{ position: 'relative' }}>
                  <textarea
                    placeholder="Enter the objective of the project..."
                    value={activeItem.project_description}
                    disabled={isViewMode}
                    onChange={e => applyDescription(e.target.value)}
                    onFocus={() => setDescFocused(true)}
                    onBlur={() => setDescFocused(false)}
                  />
                  {descSuggestions.length > 0 && (
                    <ul
                      className="desc-suggest-list"
                      onMouseDown={e => e.preventDefault()}
                      style={{
                        position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30,
                        margin: '4px 0 0', padding: 4, listStyle: 'none', maxHeight: 240, overflowY: 'auto',
                        background: 'var(--db-card, var(--db-surface, #1b2130))',
                        border: '1px solid var(--db-border, rgba(128,128,128,0.35))',
                        borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.25)'
                      }}
                    >
                      {descSuggestions.map(e => (
                        <li key={normDesc(e.description)}>
                          <button
                            type="button"
                            onClick={() => pickSuggestion(e)}
                            style={{
                              display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
                              background: 'none', border: 'none', borderRadius: 6, cursor: 'pointer',
                              font: 'inherit', color: 'var(--db-text, inherit)'
                            }}
                          >
                            <span style={{ display: 'block', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {e.description}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {errors.project_description && <p className="text-45">{errors.project_description}</p>}
              </div>

              <div className={`field-group ${errors.object_name ? 'error-state' : ''}`}>
                <label>Object Code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="e.g. 5020301002"
                  value={activeItem.object_name}
                  disabled={isViewMode}
                  onChange={e => setActiveItem({ ...activeItem, object_name: e.target.value.replace(/\D/g, '') })}
                />
                {errors.object_name && <p className="text-45">{errors.object_name}</p>}
              </div>

              <div className="field-group">
                <label>Is Indicative or Final?</label>
                <select value={newTarget?.mode === 'append' ? newTarget.record.is_indicative : headerData.is_indicative} disabled={isViewMode || newTarget?.mode === 'append'} onChange={e => setHeaderData({ ...headerData, is_indicative: e.target.value })}>
                  <option value="Indicative">Indicative</option>
                  <option value="Final">Final</option>
                </select>
              </div>

              <div className="field-group">
                <label>End-User or Implementing Unit</label>
                <input type="text" value={headerData.end_user} readOnly />
              </div>

              <div className={`field-group ${(errors.fiscal_year || fiscalYearIsClosed) ? 'error-state' : ''}`}>
                <label>Fiscal Year</label>
                <select
                  required
                  value={headerData.fiscal_year}
                  disabled={isViewMode}
                  onChange={e => {
                    const fy = e.target.value;
                    setHeaderData({ ...headerData, fiscal_year: fy, ...(recordId ? {} : { ppmp_no: nextPpmpNo(fy) }) });
                    clearError('fiscal_year');
                  }}
                >
                  {yearOptions.map(year => (
                    <option key={year} value={year} disabled={isYearLocked(year)}>
                      {year}{isYearLocked(year) ? ' (APP final – closed)' : ''}
                    </option>
                  ))}
                </select>
                {!isViewMode && fiscalYearIsClosed && <p className="text-45">{closedYearMessage}</p>}
                {!isViewMode && !fiscalYearIsClosed && errors.fiscal_year && <p className="text-45">{errors.fiscal_year}</p>}
              </div>

              <div className={`field-group ${errors.project_type ? 'error-state' : ''}`}>
                <label>Type of Project to be Procured</label>
                <select value={activeItem.project_type} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, project_type: e.target.value })}>
                  <option value="">Select...</option>
                  <option value="Goods">Goods</option>
                  <option value="Infrastructure">Infrastructure</option>
                  <option value="Consulting Services">Consulting Services</option>
                </select>
                {errors.project_type && <p className="text-45">{errors.project_type}</p>}
              </div>
            </div>

            {/* RIGHT COLUMN */}
            <div className="form-col">
              <div className={`field-group ${errors.mode ? 'error-state' : ''}`}>
                <label>Recommended Mode of Procurement</label>
                <select
                  value={activeItem.mode}
                  disabled={isViewMode || !!failedBiddingWarning}
                  onChange={e => setActiveItem({ ...activeItem, mode: e.target.value })}
                >
                  <option value="">Select mode...</option>
                  {STANDARD_PROCUREMENT_MODES.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  {(activeItem.mode?.includes('Two Failed Biddings') || !!failedBiddingWarning) && (
                    <option value={activeItem.mode || 'Negotiated Procurement – Two Failed Biddings'}>
                      {activeItem.mode || 'Negotiated Procurement – Two Failed Biddings'}
                    </option>
                  )}
                  {activeItem.mode &&
                    !STANDARD_PROCUREMENT_MODES.includes(activeItem.mode) &&
                    !activeItem.mode.includes('Two Failed Biddings') && (
                      <option value={activeItem.mode}>{activeItem.mode}</option>
                  )}
                </select>
                <p className="mode-hint">
                  Recommended by budget: &le;&#8369;199,999 &rarr; Direct Acquisition &middot; &#8369;200,000&ndash;&#8369;1,999,999 &rarr; Small Value Procurement (SVP) &middot; &#8369;2,000,000 and above &rarr; Competitive Bidding
                </p>
                {errors.mode && <p className="text-45">{errors.mode}</p>}
              </div>

              <div className={`field-group ${errors.pre_procurement ? 'error-state' : ''}`}>
                <label>Pre Procurement Conference?</label>
                <select value={activeItem.pre_procurement} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, pre_procurement: e.target.value })}>
                  <option value="">Select...</option>
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                </select>
                {errors.pre_procurement && <p className="text-45">{errors.pre_procurement}</p>}
              </div>

              <div className={`field-group ${errors.bid_evaluation_criteria ? 'error-state' : ''}`}>
                <label>Criteria for Bid Evaluation (Including Sustainability and Domestic Preference)</label>
                <select
                  value={activeItem.bid_evaluation_criteria}
                  disabled={isViewMode || !!failedBiddingWarning}
                  onChange={e => setActiveItem({ ...activeItem, bid_evaluation_criteria: e.target.value })}
                >
                  <option value="">Select Criteria for Bid Evaluation...</option>
                  {BID_CRITERIA_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  {activeItem.bid_evaluation_criteria === 'Negotiated' && <option value="Negotiated">Negotiated</option>}
                </select>
                {errors.bid_evaluation_criteria && <p className="text-45">{errors.bid_evaluation_criteria}</p>}
              </div>

              <div className={`field-group ${errors.quantity_size ? 'error-state' : ''}`}>
                <label>Quantity and Size of the Project</label>
                <textarea
                  placeholder="e.g. 10 units, 2 lots, 500 sq.m."
                  value={activeItem.quantity_size}
                  disabled={isViewMode}
                  onChange={e => setActiveItem({ ...activeItem, quantity_size: e.target.value })}
                />
                {errors.quantity_size && <p className="text-45">{errors.quantity_size}</p>}
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="form-grid">
            {/* LEFT COLUMN: timeline + budget classification */}
            <div className="form-col">
              {dateField('start_date', 'Advertisement/Posting of IB/REI (Start of Procurement Activity)')}
              {dateField('bid_opening_date', 'Submission/Opening of Bids')}
              {dateField('notice_of_award_date', 'Notice of Award')}
              {dateField('end_date', 'Contract Signing (End of Procurement Activity)')}
              {dateField('delivery_period', 'Expected Delivery/ Implementation Period')}

              <div className={`field-group ${errors.expense_class ? 'error-state' : ''}`}>
                <label>Budget Classification *</label>
                <select value={activeItem.expense_class} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, expense_class: e.target.value })}>
                  {EXPENSE_CLASS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                {errors.expense_class && <p className="text-45">{errors.expense_class}</p>}
              </div>
            </div>

            {/* RIGHT COLUMN: funding */}
            <div className="form-col">
              <div className={`field-group ${errors.fund_source ? 'error-state' : ''}`}>
                <label>Source of Funds</label>
                <input type="text" value={activeItem.fund_source} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, fund_source: e.target.value })} />
                {errors.fund_source && <p className="text-45">{errors.fund_source}</p>}
              </div>

              <div className={`field-group ${errors.budget ? 'error-state' : ''}`}>
                <label>Estimated Budget / Budgetary Allocation</label>
                <div className="budget-wrap">
                  <span className="prefix">PHP</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={activeItem.budget}
                    disabled={isViewMode}
                    onChange={e => setActiveItem({ ...activeItem, budget: e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') })}
                  />
                </div>
                {errors.budget && <p className="text-45">{errors.budget}</p>}
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="step3-stack">
            <div className={`field-group ${errors.strategies ? 'error-state' : ''}`}>
              <label>Procurement Strategies and Tools</label>
              <p className="mode-hint" style={{ margin: '0 0 8px' }}>Click to toggle one or more strategies:</p>
              <div className="strategy-wrap">
                <div className="select-box" onClick={() => !isViewMode && setStratOpen(o => !o)}>
                  {(activeItem.strategies || []).length === 0
                    ? <span className="placeholder">Select strategies...</span>
                    : activeItem.strategies.map(s => <span key={s} className="tag">{s}</span>)}
                </div>
                {stratOpen && !isViewMode && (
                  <div className="options-list">
                    {STRATEGY_OPTIONS.map(s => (
                      <div key={s} className={`option ${(activeItem.strategies || []).includes(s) ? 'selected' : ''}`} onClick={() => toggleStrategy(s)}>
                        {s}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {errors.strategies && <p className="text-45">{errors.strategies}</p>}
            </div>

            <div className="field-group">
              <label>General Requirements/Miscellaneous/Common Supplies and Equipment</label>
              <select value={activeItem.general_requirements || ''} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, general_requirements: e.target.value })}>
                <option value="">Select (optional)...</option>
                {GENERAL_REQ_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              <p className="mode-hint">Optional. Choose which one this PPMP item is, if any.</p>
            </div>

            <div className={`field-group ${errors.remarks ? 'error-state' : ''}`}>
              <label>Remarks</label>
              <textarea value={activeItem.remarks} disabled={isViewMode} onChange={e => setActiveItem({ ...activeItem, remarks: e.target.value })} />
              {errors.remarks && <p className="text-45">{errors.remarks}</p>}
            </div>

            <div className={`field-group ${errors.supporting_documents ? 'error-state' : ''}`}>
              <label>Attached Supporting Documents</label>
              <div className="doc-type-hint" style={{ padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
                {docLabel ? `Required document: ${docLabel}` : 'Select a Type of Project in Step 1 to see the required document.'}
              </div>

              {!isViewMode && (
                <>
                  <div
                    className={`upload-zone ${dragOver ? 'drag-over' : ''} ${docs.length ? 'has-file' : ''}`}
                    onClick={() => fileInputRef.current && fileInputRef.current.click()}
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
                  >
                    <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <p style={{ margin: 0 }}>Drop here to attach or <span className="upload-link">upload</span></p>
                    <small>Max 10MB per file, 50MB total</small>
                  </div>
                  <input ref={fileInputRef} type="file" multiple hidden onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
                </>
              )}

              {docs.length > 0 && (
                <ul className="uploaded-file-list">
                  {docs.map((d, i) => (
                    <li key={d.fileId || i} className="uploaded-file-item">
                      <div className="uploaded-file-info">
                        <button
                          type="button"
                          className="uploaded-file-name"
                          style={{
                            background: 'none',
                            border: 'none',
                            padding: 0,
                            textAlign: 'left',
                            font: 'inherit',
                            color: 'var(--db-accent, #0088ff)',
                            cursor: 'pointer',
                            textDecoration: 'underline'
                          }}
                          title={`Click to preview ${d.name}`}
                          onClick={() => setPreviewDoc(d)}
                        >
                          {d.name}
                        </button>
                        <span className="uploaded-file-size">({formatFileSize(d.size || 0)})</span>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <button
                          type="button"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--db-accent, #3b82f6)',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: '600',
                            padding: '2px 6px'
                          }}
                          title={`View ${d.name}`}
                          onClick={() => setPreviewDoc(d)}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: 'var(--db-accent, #3b82f6)',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: '600',
                            padding: '2px 6px'
                          }}
                          title={`Download ${d.name}`}
                          onClick={() => downloadDoc(d)}
                        >
                          Download
                        </button>
                        {!isViewMode && (
                          <button
                            type="button"
                            className="uploaded-file-remove"
                            onClick={() => removeDoc(i)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {errors.supporting_documents && <p className="text-45">{errors.supporting_documents}</p>}
            </div>
          </div>
        )}

        <div className="footer-actions">
          {step > 1
            ? <button type="button" className="back-btn" onClick={() => setStep(s => s - 1)}>&larr; Back</button>
            : <button type="button" className="back-btn" onClick={onClose}>&larr; {isViewMode ? 'Close' : 'Cancel'}</button>}

          <div className="footer-right-actions">
            {isViewMode && recordId && (
              <>
                <button type="button" className="export-app-btn" onClick={exportPpmp}>Export PDF</button>
                <button
                  type="button"
                  className="export-app-btn"
                  onClick={() => setDtmsTestDialogOpen(true)}
                  disabled={dtmsTesting}
                  title="Send a test copy to DTMS using the configured signer addresses"
                >
                  {dtmsTesting ? 'Sending test…' : 'Test DTMS Send'}
                </button>
                <button
                  type="button"
                  className="export-app-btn"
                  style={{
                    background: 'rgba(16, 185, 129, 0.15)',
                    borderColor: 'rgba(16, 185, 129, 0.4)',
                    color: 'var(--db-green, #10b981)'
                  }}
                  onClick={() => {
                    const all = JSON.parse(localStorage.getItem('procurement_records')) || [];
                    const rec = all.find(r => r.id === recordId);
                    if (rec) exportPPMP_Excel(rec, setNotice);
                  }}
                >
                  Export Excel
                </button>
              </>
            )}

            {step < 3 ? (
              <button type="button" className="next-btn" onClick={handleNext}>Next &rarr;</button>
            ) : (
              isViewMode
                ? <button type="button" className="next-btn" onClick={onClose}>Close</button>
                : <button type="button" className="next-btn" onClick={handleSave}>{recordId ? 'Save Changes' : 'Finish & Save'} &rarr;</button>
            )}
          </div>
        </div>

      </div>

      {/* Dialogs are rendered straight into <body>. Inside the form overlay they were positioned against that
          scrolling overlay instead of the window, so they slid off-screen as the form scrolled. */}
      {createPortal(
      <>
        {dtmsTestDialogOpen && (
          <div className="logout-overlay show" style={{ zIndex: 3000 }}>
            <div className="logout-modal" role="alertdialog" aria-modal="true">
              <h3>Send a PPMP test copy to DTMS?</h3>
              <p>This creates a real test document in DTMS and may notify the configured signer accounts. It routes to the Department Head, TOD, and Budget Officer only. The title will be marked [TEST] and it will not change this PPMP's local status or tracking information.</p>
              <div className="logout-actions">
                <button type="button" className="logout-cancel-btn" onClick={() => setDtmsTestDialogOpen(false)}>Cancel</button>
                <button type="button" className="logout-confirm-btn is-approve" onClick={handleConfirmDtmsTest}>Send test copy</button>
              </div>
            </div>
          </div>
        )}

        {/* Submit for Approval Confirmation Modal */}
        {submitDialogOpen && (
          <div className="logout-overlay show" style={{ zIndex: 3000 }}>
            <div className="logout-modal" role="alertdialog" aria-modal="true">
              <div className="logout-icon is-approve">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
                  <path d="M5 12L19 5L15 19L11.5 13L5 12Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
              </div>
              <h3>Submit PPMP No. {currentRecord?.ppmp_no || headerData.ppmp_no} for approval?</h3>
              <p>
                {user?.stage === 'HEAD'
                  ? 'It will be sent to DTMS for your Department Head’s digital signature. After signing, it returns to the Procurement System for TOD review. '
                  : 'It will be sent to DTMS for your Department Head’s digital signature. After signing, it returns to the Procurement System for TOD review. '}
                While it is under review it can no longer be edited or get new items.
              </p>
              <div className="logout-actions">
                <button type="button" className="logout-cancel-btn" onClick={() => setSubmitDialogOpen(false)}>Cancel</button>
                <button type="button" className="logout-confirm-btn is-approve" onClick={handleConfirmSubmit}>Submit</button>
              </div>
            </div>
          </div>
        )}

        {/* Review & Decide Dialog */}
        {reviewDialogOpen && currentRecord && (
          <div className="logout-overlay show" style={{ zIndex: 3000 }}>
            <div
              className="logout-modal review-modal"
              role="dialog"
              aria-modal="true"
              style={{ width: 'min(1180px, 96vw)', maxWidth: '96vw', height: 'min(94vh, 900px)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}
            >
              <div className="logout-icon is-approve">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none">
                  <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h3>Review PPMP No. {currentRecord.ppmp_no || 'N/A'}</h3>
              <p>
                {(() => {
                  const stepIdx = APPROVAL_CHAIN.findIndex(s => s.role === currentRecord.currentApproverRole);
                  const isLastStep = stepIdx === APPROVAL_CHAIN.length - 1;
                  const nextStep = !isLastStep && stepIdx > -1 ? APPROVAL_CHAIN[stepIdx + 1] : null;
                  const sendsForSignature = ['TOD', 'BO'].includes(currentRecord.currentApproverRole) && !!currentRecord.dtms_track;
                  return (sendsForSignature
                    ? `Approve to send it to DTMS for your digital signature. After signing, it returns to the Procurement System for ${nextStep?.label || 'the next stage'}. `
                    : nextStep
                      ? `Approve to forward it to the ${nextStep.label}. `
                      : 'Approve is the final step: it marks the PPMP Final and closes it. ') +
                    `Reject returns it to the requesting office for revision (remarks required). Your decision is recorded under ${user?.roleName || 'Approver'}.`;
                })()}
              </p>

              <style>{`
                .review-preview-scroll .excel-preview-sheet { margin: 0; border: 0; box-shadow: none; padding: 10px 16px 16px; }
                .review-preview-scroll .excel-preview-banner { text-align: center; margin: 0 0 6px; }
                .review-preview-scroll .excel-preview-banner img { display: block; max-height: 56px; width: auto; max-width: 100%; margin: 0 auto; }
                .review-preview-scroll .excel-preview-sheet h2 { text-align: center; font-size: 15px; margin: 6px 0; }
                .review-preview-scroll .excel-preview-checks { justify-content: center; margin: 4px 0 8px; }
                .review-preview-scroll .excel-preview-meta { display: flex; flex-wrap: wrap; gap: 4px 28px; justify-content: flex-start; text-align: left; margin: 0 0 10px; padding: 8px 12px; }
                .review-preview-scroll .excel-preview-meta p { margin: 0; }
              `}</style>
              {/* The whole PPMP, so the approver can read every item (scrolls both ways) before deciding. */}
              <div
                className="review-preview-scroll"
                style={{
                  flex: '1 1 0', minHeight: 200, overflow: 'auto', textAlign: 'left',
                  margin: '4px 0 16px', border: '1px solid var(--db-border, rgba(128,128,128,0.35))', borderRadius: 10
                }}
              >
                <PreviewBoundary key={currentRecord.id}>
                  <PpmpSheet record={currentRecord} notify={setNotice} onPreviewDoc={setPreviewDoc} />
                </PreviewBoundary>
              </div>

              <div className={`review-field ${reviewRemarksError ? 'has-error' : ''}`}>
                <label>Remarks / Notes (required for Reject or Remark):</label>
                <textarea
                  placeholder="Enter reason for rejection, conditions, or review remarks..."
                  value={reviewRemarks}
                  onChange={(e) => {
                    setReviewRemarks(e.target.value);
                    if (e.target.value.trim()) setReviewRemarksError(false);
                  }}
                />
                {reviewRemarksError && (
                  <span className="review-error">Please enter remarks before rejecting or commenting.</span>
                )}
              </div>

              <div className="review-actions">
                <button
                  type="button"
                  className="logout-cancel-btn"
                  disabled={stageSubmitting}
                  onClick={() => {
                    setReviewDialogOpen(false);
                    setReviewRemarks('');
                    setReviewRemarksError(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="db-action-btn"
                  disabled={stageSubmitting}
                  style={{ width: '100%', height: 'auto', padding: '10px 14px', borderRadius: 9, fontWeight: 600, fontSize: 13 }}
                  onClick={() => handleReviewAction('comment')}
                >
                  Add remark only
                </button>
                <button
                  type="button"
                  className="logout-confirm-btn is-reject"
                  disabled={stageSubmitting}
                  onClick={() => handleReviewAction('reject')}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="logout-confirm-btn is-approve"
                  disabled={stageSubmitting}
                  onClick={() => handleReviewAction('approve')}
                >
                  {stageSubmitting
                    ? 'Sending to DTMS…'
                    : ['TOD', 'BO'].includes(currentRecord.currentApproverRole) && currentRecord.dtms_track
                      ? 'Approve & Send for Signature'
                      : 'Approve'}
                </button>
              </div>
            </div>
          </div>
        )}

        {confirmDelete && (
          <div className="logout-overlay show" style={{ zIndex: 2000 }}>
            <div className="logout-modal" role="dialog" aria-modal="true">
              <div className="logout-icon">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></svg>
              </div>
              <h3>Delete this item?</h3>
              <p>{items.length > 1 ? 'This item will be permanently removed from the PPMP.' : 'This is the only item in the PPMP, so the whole PPMP will be deleted.'}</p>
              <div className="logout-actions">
                <button type="button" className="logout-cancel-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button type="button" className="logout-confirm-btn" onClick={deleteCurrentItem}>Delete</button>
              </div>
            </div>
          </div>
        )}

        <div className={`db-toast ${notice ? 'show' : ''}`} style={{ zIndex: 3100 }}>{notice}</div>

        <FilePreviewModal
          isOpen={!!previewDoc}
          onClose={() => setPreviewDoc(null)}
          doc={previewDoc}
        />
      </>,
      document.body
      )}
    </div>
  );
}