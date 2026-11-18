// Talks to server/admin-api.js (sign-in, accounts, approval flow, e-mail notifications).
// The API lives next to the DTMS proxy, so its address is derived from VITE_DTMS_PROXY.
const DTMS_PROXY = import.meta.env?.VITE_DTMS_PROXY || 'http://localhost:3001/api/dtms';
export const API_BASE = import.meta.env?.VITE_API_BASE || DTMS_PROXY.replace(/\/dtms\/?$/, '');

const TOKEN_KEY = 'dashboard_token';
const FLOW_KEY = 'flow_config_cache';
const RECORD_KEYS = new Set(['procurement_records', 'app_records']);
const syncedRecords = new Map();

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status; // 0 = server unreachable
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError('Cannot reach the server. Make sure it is running.', 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status}).`, res.status);
  return data;
}

let suppressRecordSync = false;
const pendingSync = new Map();
const syncQueues = new Map();
const activeSync = new Set();
const originalSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function setItem(key, value) {
  originalSetItem.call(this, key, value);
  if (this === window.localStorage && RECORD_KEYS.has(key) && getToken() && !suppressRecordSync) {
    const pending = pendingSync.get(key);
    if (pending) clearTimeout(pending);
    pendingSync.set(key, setTimeout(() => {
      pendingSync.delete(key);
      let records;
      try {
        records = JSON.parse(localStorage.getItem(key) || '[]');
        if (!Array.isArray(records)) throw new Error('Expected an array of records.');
      } catch (error) {
        window.dispatchEvent(new CustomEvent('persistence-error', {
          detail: { message: `Could not save ${key}: ${error.message}` }
        }));
        return;
      }
      const previousRecords = syncedRecords.get(key) || [];
      const currentById = new Map(records.map((record) => [String(record.id), record]));
      const previousById = new Map(previousRecords.map((record) => [String(record.id), record]));
      const upsert = records.filter((record) =>
        JSON.stringify(previousById.get(String(record.id))) !== JSON.stringify(record));
      const deleted = previousRecords
        .filter((record) => !currentById.has(String(record.id)))
        .map((record) => String(record.id));
      if (!upsert.length && !deleted.length) return;
      const previous = syncQueues.get(key) || Promise.resolve();
      activeSync.add(key);
      const next = previous.catch(() => {}).then(async () => {
        await api(`/data/${key}`, { method: 'PATCH', body: { upsert, deleted } });
        syncedRecords.set(key, records);
      }).finally(() => activeSync.delete(key));
      syncQueues.set(key, next);
      next.catch((error) => {
        console.error(`Could not save ${key} to the shared database:`, error);
        window.dispatchEvent(new CustomEvent('persistence-error', {
          detail: { message: 'Your changes are on this device but could not be saved to the shared database.' }
        }));
      });
    }, 200));
  }
};

function setCachedRecords(data) {
  suppressRecordSync = true;
  try {
    originalSetItem.call(localStorage, 'procurement_records', JSON.stringify(data.procurement_records || []));
    originalSetItem.call(localStorage, 'app_records', JSON.stringify(data.app_records || []));
    syncedRecords.set('procurement_records', data.procurement_records || []);
    syncedRecords.set('app_records', data.app_records || []);
  } finally {
    suppressRecordSync = false;
  }
}

export async function initializeRemoteData() {
  let data = await api('/data');
  const firstLogin = !data.initialized;
  if (!data.initialized) {
    const localData = {
      procurement_records: JSON.parse(localStorage.getItem('procurement_records') || '[]'),
      app_records: JSON.parse(localStorage.getItem('app_records') || '[]')
    };
    try {
      await api('/data/initialize', { method: 'POST', body: localData });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
    data = await api('/data');
  }
  setCachedRecords(data);
  return { ...data, migrateLegacyFiles: firstLogin };
}

export async function refreshRemoteData(shouldApply = () => true) {
  if (pendingSync.size || activeSync.size || !syncedRecords.size) return false;
  const localRecords = Object.fromEntries([...RECORD_KEYS].map((key) => {
    let value = [];
    try { value = JSON.parse(localStorage.getItem(key) || '[]'); } catch { /* handled by regular sync */ }
    return [key, value];
  }));
  if ([...RECORD_KEYS].some((key) =>
    JSON.stringify(localRecords[key]) !== JSON.stringify(syncedRecords.get(key)))) return false;

  let data;
  try {
    data = await api('/data');
  } catch (error) {
    window.dispatchEvent(new CustomEvent('persistence-error', {
      detail: { message: 'Could not refresh shared records from the server database. Check the server connection.' }
    }));
    throw error;
  }
  if (!shouldApply() || [...RECORD_KEYS].some((key) => {
    let current = [];
    try { current = JSON.parse(localStorage.getItem(key) || '[]'); } catch { return true; }
    return JSON.stringify(current) !== JSON.stringify(syncedRecords.get(key));
  })) return false;
  const changed = [...RECORD_KEYS].some((key) =>
    JSON.stringify(data[key]) !== JSON.stringify(syncedRecords.get(key)));
  if (!changed) return false;
  setCachedRecords(data);
  return true;
}

async function fileRequest(id, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}/files/${encodeURIComponent(id)}`, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': options.body.type || 'application/octet-stream' } : {}),
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        ...(options.headers || {})
      }
    });
  } catch {
    throw new ApiError('Cannot reach the server. Make sure it is running.', 0);
  }
  if (!response.ok) {
    let data = {};
    try { data = await response.json(); } catch { /* empty body */ }
    throw new ApiError(data.error || `File request failed (${response.status}).`, response.status);
  }
  return response;
}

export const apiGetFile = async (id) => (await fileRequest(id)).blob();
export const apiPutFile = (id, blob) => fileRequest(id, { method: 'PUT', body: blob });
export const apiDeleteFile = (id) => fileRequest(id, { method: 'DELETE' });

// --- session
export const apiLogin = (email, password) => api('/auth/login', { method: 'POST', body: { email, password } });
export const apiMe = () => api('/auth/me');
export const apiChangePassword = (current, next) => api('/auth/change-password', { method: 'POST', body: { current, next } });

// --- admin
export const adminMeta = () => api('/admin/meta');
export const adminListAccounts = () => api('/admin/accounts');
export const adminCreateAccount = (body) => api('/admin/accounts', { method: 'POST', body });
export const adminUpdateAccount = (id, body) => api(`/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body });
export const adminResetPassword = (id, password) => api(`/admin/accounts/${encodeURIComponent(id)}/reset-password`, { method: 'POST', body: { password } });
export const adminSaveFlow = (flow) => api('/admin/flow', { method: 'PUT', body: { flow } });
export const adminAudit = () => api('/admin/audit');
export const adminTestEmail = (to) => api('/admin/test-email', { method: 'POST', body: { to } });

// --- approval flow cache (read synchronously by dtmsClient.js)
let flowCache = null;
export function getCachedFlow() {
  if (flowCache) return flowCache;
  try {
    flowCache = JSON.parse(localStorage.getItem(FLOW_KEY));
  } catch {
    flowCache = null;
  }
  return flowCache;
}
export async function refreshFlow() {
  const { flow } = await api('/flow');
  flowCache = flow;
  try { localStorage.setItem(FLOW_KEY, JSON.stringify(flow)); } catch { /* storage full */ }
  return flow;
}
export function clearFlowCache() {
  flowCache = null;
  localStorage.removeItem(FLOW_KEY);
}

// --- notifications: fire and forget, never blocks or breaks an approval
export function notifyFlow({ kind, event, stage, record, remarks, round }) {
  if (!getToken()) return;
  const body = {
    kind, event, stage, remarks, round,
    record: { ppmp_no: record?.ppmp_no, end_user: record?.end_user, fiscal_year: record?.fiscal_year }
  };
  api('/notify', { method: 'POST', body }).catch((err) => console.warn('Notification not sent:', err.message));
}
