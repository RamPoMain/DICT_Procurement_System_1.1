import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';

export default function Sidebar({ onNewRequest, hasPendingApprovals = false }) {
  const { user, logout } = useAuth();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // Generate 2-letter initials for avatar (e.g., "IL", "FP", "TO", "RD")
  const initials = user?.role ? user.role.slice(0, 2).toUpperCase() : '??';

  return (
    <>
      <aside className="db-sidebar">
        {/* Brand / Logo */}
        <div className="db-brand">
          <img
            src="/images/DICT-Logo.png"
            alt="DICT Logo"
            className="db-sidebar-logo-img"
          />
          <span className="db-brand-text">DICT Procurement</span>
        </div>

        {/* Navigation Items */}
        <nav className="db-nav">
          {/* Dashboard */}
          <NavLink
            to="/"
            end
            className={({ isActive }) => `db-nav-item ${isActive ? 'active' : ''}`}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
            Dashboard
            {hasPendingApprovals && (
              <span
                style={{
                  marginLeft: 'auto',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--db-accent, #3b82f6)',
                  boxShadow: '0 0 6px var(--db-accent, #3b82f6)'
                }}
                title="You have requests waiting for approval"
              />
            )}
          </NavLink>

          {/* Entries (PPMP & APP tables) */}
          <NavLink
            to="/entries"
            className={({ isActive }) => `db-nav-item ${isActive ? 'active' : ''}`}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Entries
          </NavLink>

          {/* New Request Button - Only shown to users with canRequest rights */}
          {user?.canRequest && (
            <button
              type="button"
              className="db-nav-item"
              onClick={onNewRequest}
              style={{
                background: 'none',
                border: 'none',
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                fontFamily: 'inherit'
              }}
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="16" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
              New Request
            </button>
          )}

          {/* Profile */}
          <NavLink
            to="/profile"
            className={({ isActive }) => `db-nav-item ${isActive ? 'active' : ''}`}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Profile
          </NavLink>
        </nav>

        {/* Sidebar Footer (User details + Logout) */}
        <div className="db-sidebar-footer">
          <div className="db-user-mini">
            <div className="db-avatar">{initials}</div>
            <div className="db-user-text">
              <p className="db-user-name">{user?.roleName || 'Guest'}</p>
              <p className="db-user-email">{user?.email || ''}</p>
            </div>
          </div>
          <button
            type="button"
            className="db-logout"
            title="Log out"
            onClick={() => setShowLogoutConfirm(true)}
          >
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </aside>

      {/* Logout Confirmation Modal */}
      {showLogoutConfirm && (
        <div className="logout-overlay show">
          <div className="logout-modal" role="dialog" aria-modal="true">
            <div className="logout-icon">
              <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path d="M9 20H5.6C5 20 4.5 19.5 4.5 18.9V5.1C4.5 4.5 5 4 5.6 4H9" />
                <path d="M15.5 16L19.5 12L15.5 8" />
                <path d="M19.2 12H10" />
              </svg>
            </div>
            <h3>Log out?</h3>
            <p>You will need to sign in again to access procurement records.</p>
            <div className="logout-actions">
              <button
                type="button"
                className="logout-cancel-btn"
                onClick={() => setShowLogoutConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="logout-confirm-btn"
                onClick={() => {
                  setShowLogoutConfirm(false);
                  logout();
                }}
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}