// Supporting-document helpers for the Entries dropdown: open, download and
// attach. File bytes live in IndexedDB (FileStore); the record only keeps a
// reference ({ name, size, type, fileId }). Older records may still hold a
// base64 `dataUrl`, which FileStore.docBlob() also understands.
//
// >>> Adjust this import to wherever your FileStore lives. <<<
import { FileStore } from './fileStore.js';

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_TOTAL_SIZE = 50 * 1024 * 1024;

export const hasStoredContent = (doc) => !!(doc && (doc.fileId || doc.dataUrl));

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const newFileId = () => FileStore.newId();
export const putFile = (id, file) => FileStore.put(id, file);
export function removeFile(id) {
  try { return FileStore.remove(id); } catch { return undefined; }
}

async function resolveBlob(doc, toast) {
  if (!hasStoredContent(doc)) {
    toast('This file could not be opened - its contents were not saved. Re-attach it by editing the item.');
    return null;
  }
  try {
    const blob = await FileStore.docBlob(doc);
    if (!blob) throw new Error('empty');
    return blob;
  } catch {
    toast('This file could not be read. Re-attach it by editing the item.');
    return null;
  }
}

function saveAs(url, fileName) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function openStoredDoc(doc, toast) {
  // Open the tab inside the click so pop-up blockers allow it.
  const win = window.open('', '_blank');
  const blob = await resolveBlob(doc, toast);
  if (!blob) { if (win) win.close(); return; }
  const url = URL.createObjectURL(blob);
  if (win) {
    win.location.href = url;
  } else {
    saveAs(url, doc.name || 'document');
    toast('Your browser blocked the new tab, so the file was downloaded instead.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export async function downloadStoredDoc(doc, toast) {
  const blob = await resolveBlob(doc, toast);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  saveAs(url, doc.name || 'document');
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Splits picked files into accepted ones and human-readable problems.
export function screenFiles(files, existingDocs, pendingBytes = 0) {
  const docs = Array.isArray(existingDocs) ? existingDocs : [];
  let used = docs.reduce((sum, d) => sum + (Number(d.size) || 0), 0) + pendingBytes;
  const accepted = [];
  const problems = [];

  files.forEach((file) => {
    if (docs.some((d) => d.name === file.name && Number(d.size) === file.size)) {
      problems.push(`"${file.name}" is already attached.`);
    } else if (file.size > MAX_FILE_SIZE) {
      problems.push(`"${file.name}" is ${formatFileSize(file.size)}, over the ${formatFileSize(MAX_FILE_SIZE)} per-file limit.`);
    } else if (used + file.size > MAX_TOTAL_SIZE) {
      problems.push(`Adding "${file.name}" would exceed the ${formatFileSize(MAX_TOTAL_SIZE)} limit for this item.`);
    } else {
      used += file.size;
      accepted.push(file);
    }
  });
  return { accepted, problems };
}
