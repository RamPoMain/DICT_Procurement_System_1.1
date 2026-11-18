import { apiDeleteFile, apiGetFile, apiPutFile } from './adminApi.js';

const DB_NAME = 'dict_procurement_files';
const STORE = 'files';
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(mode, work) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    const req = work(store);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  }));
}

export const FileStore = {
  newId: () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
  put: (id, blob) => apiPutFile(id, blob),
  get: async (id) => {
    try {
      return await apiGetFile(id);
    } catch (error) {
      if (error.status !== 404) throw error;
      const legacy = await run('readonly', s => s.get(id));
      if (legacy) {
        await apiPutFile(id, legacy);
        return legacy;
      }
      return null;
    }
  },
  remove: (id) => apiDeleteFile(id),
  docBlob: async (doc) => {
    if (!doc) return null;
    if (doc.fileId) return (await FileStore.get(doc.fileId)) || null;
    if (doc.dataUrl) {
      const parts = doc.dataUrl.split(',');
      const mime = parts[0].match(/:(.*?);/)?.[1] || 'application/octet-stream';
      const bstr = atob(parts[1]);
      const u8 = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      return new Blob([u8], { type: mime });
    }
    return null;
  }
};

export async function migrateLegacyFiles(records) {
  const ids = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, child]) => {
        if ((key === 'fileId' || key.endsWith('_file_id')) && typeof child === 'string') ids.add(child);
        visit(child);
      });
    }
  };
  visit(records);
  for (const id of ids) {
    const blob = await run('readonly', (store) => store.get(id));
    if (blob) await apiPutFile(id, blob);
  }
}

export default FileStore;