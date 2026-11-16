// Talks to server/admin-api.js (sign-in, accounts, approval flow, e-mail notifications).
// The API lives next to the DTMS proxy, so its address is derived from VITE_DTMS_PROXY.
const DTMS_PROXY = import.meta.env?.VITE_DTMS_PROXY || 'http://localhost:3001/api/dtms';
export const API_BASE = import.meta.env?.VITE_API_BASE || DTMS_PROXY.replace(/\/dtms\/?$/, '');

const TOKEN_KEY = 'dashboard_token';
const FLOW_KEY = 'flow_config_cache';

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
