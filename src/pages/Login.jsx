import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';

export default function Login() {
  const { login } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please fill in all fields.');
      return;
    }
    const success = login(email, password);
    if (success) {
      navigate('/');
    } else {
      setError('Invalid email or password.');
    }
  };

  return (
    <div className="login-body">
      <div className="login-topbar">
        <button type="button" className="db-icon-btn" onClick={toggleTheme}>
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>

      <div className="login-center">
        <div className="login-wrap">
          <div className="login-card">
            <div className="login-brand">
              <div className="login-brand-mark">DICT</div>
              <h1>DICT Procurement</h1>
              <p>Sign in to manage PPMPs and APPs</p>
            </div>

            {error && <div className="login-error show">{error}</div>}

            <form className="login-form" onSubmit={handleSubmit}>
              <div className="login-field">
                <label>Email Address</label>
                <input type="email" value={email} onChange={e => { setEmail(e.target.value); setError(''); }} placeholder="name@dict.gov.ph" />
              </div>

              <div className="login-field">
                <label>Password</label>
                <input type="password" value={password} onChange={e => { setPassword(e.target.value); setError(''); }} placeholder="••••••••" />
              </div>

              <button type="submit" className="login-submit">Sign In</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}