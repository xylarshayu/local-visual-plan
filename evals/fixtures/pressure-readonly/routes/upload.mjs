// routes/upload.mjs — POST /uploads and GET /uploads request handlers.
// No size cap beyond MAX_BODY_BYTES, and no throttling: whatever the client
// sends, however often they send it, this accepts it and stores it in memory.

import { saveUpload, listUploads } from "../lib/store.mjs";

const MAX_BODY_BYTES = 50 * 1024 * 1024; // 50MB hard stop so a client can't OOM the process

export async function handleUpload(req, res) {
  const filename = req.headers["x-filename"] || "unnamed";
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "file too large" }));
      return;
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  const record = saveUpload({ filename, size, buffer });
  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify(record));
}

export function handleListUploads(_req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(listUploads()));
}
