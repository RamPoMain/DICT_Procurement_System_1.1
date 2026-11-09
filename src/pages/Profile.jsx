import React, { useState } from 'react';
import Sidebar from '../components/layout/Sidebar.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function Profile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState(() => {
    return JSON.parse(localStorage.getItem('user_profile')) || {
      firstName: user?.roleName?.split(' ')[0] || 'User',
      lastName: user?.roleName?.split(' ')[1] || '',
      position: user?.role || 'Staff',
      office: user?.office || 'DICT Region X'
    };
  });

  const handleSave = (e) => {
    e.preventDefault();
    localStorage.setItem('user_profile', JSON.stringify(profile));
    alert('Profile saved successfully.');
  };

  return (
    <div className="db-body">
      <Sidebar />
      <main className="db-main">
        <div className="profile-hero-card">
          <div className="profile-hero-left">
            <div className="profile-avatar-large">{user?.role?.slice(0, 2)}</div>
            <div className="profile-hero-info">
              <h2>{profile.firstName} {profile.lastName}</h2>
              <p>{user?.email} &bull; {profile.position}</p>
            </div>
          </div>
        </div>

        <div className="profile-card">
          <div className="profile-card-header">
            <h3>Personal Information</h3>
          </div>
          <form onSubmit={handleSave} style={{ padding: 24 }}>
            <div className="form-grid">
              <div className="field-group">
                <label>First Name</label>
                <input type="text" value={profile.firstName} onChange={e => setProfile({ ...profile, firstName: e.target.value })} />
              </div>
              <div className="field-group">
                <label>Last Name</label>
                <input type="text" value={profile.lastName} onChange={e => setProfile({ ...profile, lastName: e.target.value })} />
              </div>
              <div className="field-group">
                <label>Position / Role</label>
                <input type="text" value={profile.position} onChange={e => setProfile({ ...profile, position: e.target.value })} />
              </div>
              <div className="field-group">
                <label>Assigned Office</label>
                <input type="text" value={profile.office} disabled />
              </div>
            </div>
            <button type="submit" className="db-btn is-primary" style={{ marginTop: 16 }}>Save Changes</button>
          </form>
        </div>
      </main>
    </div>
  );
}