import React, { useState, useEffect } from 'react';
import FileStore from '../../utils/fileStore.js';

export default function FilePreviewModal({ isOpen, onClose, doc }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen || !doc) {
      setBlobUrl(null);
      setError('');
      return;
    }

    let isMounted = true;
    let createdUrl = null;
    setLoading(true);
    setError('');

    FileStore.docBlob(doc)
      .then((blob) => {
        if (!isMounted) return;
        if (!blob) {
          setError('File data not found in browser storage.');
          return;
        }
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
      })
      .catch((err) => {
        if (!isMounted) return;
        console.error('Error loading file blob:', err);
        setError('Could not load file from browser storage.');
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [isOpen, doc]);

  if (!isOpen || !doc) return null;

  const fileName = doc.name || 'Document';
  const fileExt = fileName.split('.').pop()?.toLowerCase() || '';
  const isPdf = doc.type === 'application/pdf' || fileExt === 'pdf';
  const isImage = (doc.type && doc.type.startsWith('image/')) || ['png', 'jpg', 'jpeg', 'svg', 'webp', 'gif'].includes(fileExt);
  const isText = (doc.type && doc.type.startsWith('text/')) || ['txt', 'csv', 'json', 'log'].includes(fileExt);

  const handleDownload = () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div
      className="app-preview-overlay show"
      style={{ zIndex: 3500 }}
      onClick={(e) => e.target.classList.contains('app-preview-overlay') && onClose()}
    >
      <div className="app-preview-modal" style={{ maxWidth: '960px', height: '85vh' }} role="dialog" aria-modal="true">
        <div className="app-preview-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
            <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fileName}
            </h3>
            {doc.size ? (
              <span style={{ fontSize: '11px', color: 'var(--db-text-dim)', background: 'var(--db-border)', padding: '2px 8px', borderRadius: '6px', flexShrink: 0 }}>
                {doc.size >= 1024 * 1024 ? `${(doc.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(doc.size / 1024))} KB`}
              </span>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {blobUrl && (
              <button
                type="button"
                className="app-preview-btn is-secondary"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '7px 15px',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  borderRadius: '8px',
                  border: '1px solid var(--db-field-border, rgba(255,255,255,0.18))',
                  background: 'var(--db-card-alt, rgba(255,255,255,0.08))',
                  color: 'var(--db-text, #ffffff)',
                  cursor: 'pointer',
                  lineHeight: 1,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
                }}
                onClick={handleDownload}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download
              </button>
            )}
            <button type="button" className="app-preview-x" onClick={onClose} aria-label="Close preview">
              &times;
            </button>
          </div>
        </div>

        <div className="app-preview-body" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, justifyContent: 'center', alignItems: 'center' }}>
          {loading && <p style={{ color: 'var(--db-accent)' }}>Loading file preview...</p>}
          {error && <p style={{ color: '#ef4444' }}>{error}</p>}

          {!loading && !error && blobUrl && (
            <>
              {isPdf && (
                <iframe
                  src={`${blobUrl}#view=FitH`}
                  className="app-preview-frame"
                  title={fileName}
                  style={{ width: '100%', height: '100%', border: '1px solid var(--db-border)', borderRadius: '8px' }}
                />
              )}

              {isImage && (
                <div style={{ flex: 1, width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'auto', background: 'rgba(0,0,0,0.03)', borderRadius: '8px' }}>
                  <img
                    src={blobUrl}
                    alt={fileName}
                    style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '4px' }}
                  />
                </div>
              )}

              {isText && (
                <iframe
                  src={blobUrl}
                  className="app-preview-frame"
                  title={fileName}
                  style={{ width: '100%', height: '100%', border: '1px solid var(--db-border)', borderRadius: '8px' }}
                />
              )}

              {!isPdf && !isImage && !isText && (
                <div style={{ textAlign: 'center', padding: '40px 20px', maxWidth: '480px' }}>
                  <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto 16px', color: 'var(--db-text-dim)' }}>
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                  <h4 style={{ margin: '0 0 8px', fontSize: '15px' }}>{fileName}</h4>
                  <p style={{ margin: '0 0 20px', fontSize: '13px', color: 'var(--db-text-dim)' }}>
                    Preview is supported for PDF, images, and text files. For this document format, please download the file to view.
                  </p>
                  <button
                    type="button"
                    className="app-preview-btn"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '9px 18px',
                      fontSize: '13px'
                    }}
                    onClick={handleDownload}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Download to View
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
