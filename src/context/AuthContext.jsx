import React, { createContext, useContext, useState, useEffect } from 'react';

export const ACCOUNTS = [
  {
    email: 'ILCDB@dict.gov.ph',
    password: '1',
    role: 'ILCDB',
    roleName: 'ILCDB',
    office: 'ICT Literacy Competency and Development bureau',
    canRequest: true
  },
  {
    email: 'FPIAP@dict.gov.ph',
    password: '1',
    role: 'FPIAP',
    roleName: 'FPIAP',
    office: 'Free Public Internet Access Program',
    canRequest: true
  },
  {
    email: 'GASS@dict.gov.ph',
    password: '1',
    role: 'GASS',
    roleName: 'GASS',
    office: 'General Administration and Support Services',
    canRequest: true
  },
  {
    email: 'FPIAPHEAD@dict.gov.ph',
    password: '1',
    role: 'FPIAPH',
    roleName: 'FPIAP Head',
    office: 'Free Public Internet Access Program',
    canRequest: true,
    canApprove: true,
    stage: 'HEAD',
    headOf: 'Free Public Internet Access Program'
  },
  {
    email: 'ILCDBHEAD@dict.gov.ph',
    password: '1',
    role: 'ILCDBH',
    roleName: 'ILCDB Head',
    office: 'ICT Literacy Competency and Development bureau',
    canRequest: true,
    canApprove: true,
    stage: 'HEAD',
    headOf: 'ICT Literacy Competency and Development bureau'
  },
  {
    email: 'GASSHEAD@dict.gov.ph',
    password: '1',
    role: 'GASSH',
    roleName: 'GASS Head',
    office: 'General Administration and Support Services',
    canRequest: true,
    canApprove: true,
    stage: 'HEAD',
    headOf: 'General Administration and Support Services'
  },
  {
    email: 'tod@dict.gov.ph',
    password: '1',
    role: 'TOD',
    roleName: 'Technical Operations Division',
    office: 'Technical Operations Division',
    canApprove: true,
    stage: 'TOD'
  },
  {
    email: 'BudgetOfficer@dict.gov.ph',
    password: '1',
    role: 'BO',
    roleName: 'Budget Officer',
    office: 'Budget Office',
    canApprove: true,
    stage: 'BO'
  },
  {
    email: 'ard@dict.gov.ph',
    password: '1',
    role: 'ARD',
    roleName: 'Assistant Regional Director',
    canApprove: true,
    stage: 'RD' // For PPMP stage
  },
  {
    email: 'rd@dict.gov.ph',
    password: '1',
    role: 'RD',
    roleName: 'Regional Director',
    canApprove: true,
    stage: 'RD'
  },
  {
    email: 'supply@dict.gov.ph',
    password: '1',
    role: 'SUP',
    roleName: 'Supply',
    canRequest: false,
    canApprove: false,
    canTrackApprovals: true
  },
  {
    email: 'test@dict.gov.ph',
    password: '1',
    role: 'POP',
    roleName: 'POP (Test Account)',
    office: 'POP Test Office',
    canRequest: true,
    canApprove: false
  }
];

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem('dashboard_session'));
      if (!s?.email) return null;
      const acct = ACCOUNTS.find(a => a.email.toLowerCase() === s.email.toLowerCase());
      return acct ? { ...acct, id: acct.email.toLowerCase() } : null;
    } catch {
      return null;
    }
  });

  const login = (email, password) => {
    const acct = ACCOUNTS.find(
      a => a.email.toLowerCase() === email.trim().toLowerCase() && a.password === password
    );
    if (!acct) return false;
    const sessionObj = { ...acct, id: acct.email.toLowerCase() };
    localStorage.setItem('dashboard_session', JSON.stringify(sessionObj));
    setUser(sessionObj);
    return true;
  };

  const logout = () => {
    localStorage.removeItem('dashboard_session');
    setUser(null);
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
      login,
      logout,
      canActOnRecord,
      isAppAuthorized: ['SUP', 'ARD', 'RD'].includes(user?.role)
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);