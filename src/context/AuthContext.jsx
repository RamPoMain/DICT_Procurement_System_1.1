import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  apiLogin, apiMe, getToken, setToken, clearToken,
  refreshFlow, clearFlowCache
} from '../utils/adminApi.js';

// Accounts now live on the server (Admin page). Kept only so old imports do not break.
export const ACCOUNTS = [];

const SESSION_KEY = 'dashboard_session';
const AuthContext = createContext(null);

function readCachedUser() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return s?.email && getToken() ? s : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(readCachedUser);

  const setUser = (u) => {
    if (u) localStorage.setItem(SESSION_KEY, JSON.stringify(u));
    else localStorage.removeItem(SESSION_KEY);
    setUserState(u);
  };

  const logout = () => {
    clearToken();
    clearFlowCache();
    setUser(null);
  };

  // Re-check the saved session with the server (account may have been changed or deactivated),
  // and load the approval-flow settings used for DTMS signers.
  useEffect(() => {
    if (!getToken()) return undefined;
    let cancelled = false;
    apiMe()
      .then(({ user: fresh }) => { if (!cancelled) setUser(fresh); })
      .catch((err) => { if (!cancelled && err.status === 401) logout(); });
    refreshFlow().catch(() => {});
    const onVisible = () => {
      if (document.visibilityState === 'visible' && getToken()) refreshFlow().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Returns { ok: true } or { ok: false, error }.
  const login = async (email, password) => {
    try {
      const { token, user: signedIn } = await apiLogin(email.trim(), password);
      setToken(token);
      setUser(signedIn);
      refreshFlow().catch(() => {});
      return { ok: true, user: signedIn };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };

  // Helper checking if user can act on a specific PPMP record
  const canActOnRecord = (record) => {
    if (!user || !user.canApprove || !record) return false;
    if (record.status !== 'For Approval') return false;
    if (record.dtms_track && (
      !record.dtms_signing_complete ||
      record.dtms_signed_file_track !== record.dtms_track
    )) return false;
    if (record.currentApproverRole !== user.stage) return false;
    if (user.stage === 'HEAD') return record.end_user === user.headOf;
    return true;
  };

  return (
    <AuthContext.Provider value={{
      user,
      setUser,
      login,
      logout,
      canActOnRecord,
      isAdmin: !!user?.canAdmin,
      isAppAuthorized: ['SUP', 'ARD', 'RD'].includes(user?.role)
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);