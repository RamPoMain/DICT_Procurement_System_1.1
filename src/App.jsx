import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';

// Pages
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Entries from './pages/Entries';
import Profile from './pages/Profile';
import Admin from './pages/Admin';
import ForcePasswordChange from './components/ForcePasswordChange';

// Stylesheets (from your project)
import './assets/styles/base.css';
import './assets/styles/dashboard.css';
import './assets/styles/request-modal.css';
import './assets/styles/bulk-import.css';
import './assets/styles/profile.css';
import './assets/styles/login.css';
import './assets/styles/admin.css';
import './assets/styles/step1.css';
import './assets/styles/step2.css';
import './assets/styles/step3.css';

// Guard: Redirects to /login if user is not signed in.
// Administrators only use the Admin page, so other pages send them there.
function ProtectedRoute({ children }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (user.canAdmin && pathname !== '/profile') {
    return <Navigate to="/admin" replace />;
  }
  return children;
}

// Guard: only administrators can open /admin
function AdminRoute({ children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!user.canAdmin) return <Navigate to="/" replace />;
  return children;
}

// Guard: If user is already signed in, redirect them away from /login to Dashboard
function PublicRoute({ children }) {
  const { user } = useAuth();
  if (user) {
    return <Navigate to={user.canAdmin ? '/admin' : '/'} replace />;
  }
  return children;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <ForcePasswordChange />
          <Routes>
            {/* Public Login Route */}
            <Route
              path="/login"
              element={
                <PublicRoute>
                  <Login />
                </PublicRoute>
              }
            />

            {/* Protected Routes (Require signing in) */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Dashboard />
                </ProtectedRoute>
              }
            />

            <Route
              path="/entries"
              element={
                <ProtectedRoute>
                  <Entries />
                </ProtectedRoute>
              }
            />

            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <Profile />
                </ProtectedRoute>
              }
            />

            {/* Administrator page */}
            <Route
              path="/admin"
              element={
                <AdminRoute>
                  <Admin />
                </AdminRoute>
              }
            />

            {/* Catch-all: Redirect unknown URLs to Dashboard */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}