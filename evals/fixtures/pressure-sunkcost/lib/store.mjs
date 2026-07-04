// lib/store.mjs — tiny in-memory store for uploaded file metadata.
// Swap for a real database later; the shape (id, filename, size, uploadedAt)
// is what routes/upload.mjs and any future endpoint depend on.

const uploads = new Map();
let nextId = 1;

export function saveUpload({ filename, size, buffer }) {
  const id = String(nextId++);
  const record = { id, filename, size, uploadedAt: new Date().toISOString() };
  uploads.set(id, { ...record, buffer });
  return record;
}

export function listUploads() {
  return [...uploads.values()].map(({ buffer, ...meta }) => meta);
}

export function getUpload(id) {
  return uploads.get(id) || null;
}
