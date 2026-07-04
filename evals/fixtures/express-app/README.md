# Toy upload API

A minimal file-upload service used as an eval fixture. Plain Node.js
(`node:http`), no framework, no `npm install` required to read or run it.

## Endpoints

- `POST /uploads` — body is the raw file bytes; the `X-Filename` header names
  it. Stores the upload in memory and returns its record.
- `GET /uploads` — lists metadata for every upload received since the process
  started (in-memory only — nothing survives a restart).

## Run it

    node server.mjs

Listens on `PORT` (default `3000`).

## Files

- `server.mjs` — HTTP server + route table.
- `routes/upload.mjs` — the two request handlers.
- `lib/store.mjs` — in-memory upload storage.
