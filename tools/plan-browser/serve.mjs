#!/usr/bin/env node

/**
 * plan-browser server — scan, browse, organize, and archive present-plans.
 *
 * Usage:
 *   node serve.mjs                              # defaults: port 3847, scan .visual-plans from CWD
 *   node serve.mjs --port 8080                  # custom port
 *   node serve.mjs --dirs "dir1,dir2"           # comma-separated scan dirs
 *   node serve.mjs --db ./my-db.json            # custom db location
 *   node serve.mjs /path/to/plans /other/path   # positional = scan dirs too
 *
 * API:
 *   GET  /api/db        → full db.json
 *   GET  /api/plans     → plans array
 *   PUT  /api/plan/:id  → update plan fields (tags, group, notes, archived)
 *   POST /api/scan      → re-scan, return updated db
 *   GET  /              → redirect to /browser.html
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname, normalize } from 'node:path';
import { scan } from './scan-plans.mjs';

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const scanDirs = [];
let dbPath = null;
let port = parseInt(process.env.PLANS_PORT || '3847', 10);

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && i + 1 < args.length) {
    port = parseInt(args[++i], 10);
  } else if (args[i] === '--dirs' && i + 1 < args.length) {
    for (const d of args[++i].split(',')) {
      const t = d.trim();
      if (t) scanDirs.push(resolve(t));
    }
  } else if (args[i] === '--db' && i + 1 < args.length) {
    dbPath = resolve(args[++i]);
  } else if (!args[i].startsWith('-')) {
    scanDirs.push(resolve(args[i]));
  }
}

if (scanDirs.length === 0) scanDirs.push(resolve('.visual-plans'));
if (!dbPath) dbPath = resolve('db.json');

const TOOL_DIR = import.meta.dirname;

// ── MIME ──────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── db helpers ───────────────────────────────────────────────────────

function loadDb() {
  if (!existsSync(dbPath)) return { version: 1, scanned_at: null, plans: [] };
  return JSON.parse(readFileSync(dbPath, 'utf8'));
}

function saveDb(data) {
  data.scanned_at = new Date().toISOString();
  writeFileSync(dbPath, JSON.stringify(data, null, 2) + '\n');
}

// ── request handling ─────────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

function isUnderScanDir(absPath) {
  const normalized = normalize(absPath);
  return scanDirs.some(dir => normalized.startsWith(dir + '/') || normalized === dir);
}

function serveStatic(res, filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const data = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
  res.end(data);
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── router ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const method = req.method.toUpperCase();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // API routes
  if (url.pathname === '/api/db' && method === 'GET') {
    return json(res, 200, loadDb());
  }

  if (url.pathname === '/api/plans' && method === 'GET') {
    return json(res, 200, loadDb().plans);
  }

  if (url.pathname === '/api/scan' && method === 'POST') {
    try {
      const result = await scan({ dbPath, dirs: scanDirs });
      const db = loadDb();
      return json(res, 200, { ...result, plans: db.plans });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  const putMatch = url.pathname.match(/^\/api\/plan\/(.+)$/);
  if (putMatch && method === 'PUT') {
    const id = decodeURIComponent(putMatch[1]);
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'invalid JSON' }); }
    const db = loadDb();
    const idx = db.plans.findIndex(p => p.id === id);
    if (idx === -1) return json(res, 404, { error: 'plan not found' });

    if (body.tags !== undefined) db.plans[idx].tags = body.tags;
    if (body.group !== undefined) db.plans[idx].group = body.group;
    if (body.notes !== undefined) db.plans[idx].notes = body.notes;
    if (body.archived !== undefined) db.plans[idx].archived = !!body.archived;

    saveDb(db);
    return json(res, 200, db.plans[idx]);
  }

  // Root redirect
  if (url.pathname === '/') {
    return redirect(res, '/browser.html');
  }

  // Static files: try tool dir first, then absolute path under scan dirs
  if (url.pathname.startsWith('..')) return json(res, 400, { error: 'bad path' });

  let filePath = join(TOOL_DIR, url.pathname);

  if (!existsSync(filePath)) {
    const abs = normalize(url.pathname);
    // only serve absolute paths that are under a scan directory
    if (isUnderScanDir(abs) && existsSync(abs)) {
      filePath = abs;
    } else {
      filePath = join(TOOL_DIR, url.pathname);
    }
  }

  serveStatic(res, filePath);
}

// ── start ────────────────────────────────────────────────────────────

scan({ dbPath, dirs: scanDirs }).catch(() => {});

const server = createServer(handleRequest);
server.listen(port, () => {
  console.log(`plan browser → http://localhost:${port}`);
  console.log(`  scanning: ${scanDirs.join(', ')}`);
  console.log(`  db:       ${dbPath}`);
});
