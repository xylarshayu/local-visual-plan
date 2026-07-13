#!/usr/bin/env node

/**
 * scan-plans.mjs — Discover present-plan HTML files, extract metadata,
 * write/update db.json. Zero dependencies (Node built-ins only).
 *
 * Usage:
 *   node scan-plans.mjs                                # defaults: scan .visual-plans from CWD
 *   node scan-plans.mjs --db ./db.json                 # custom db path
 *   node scan-plans.mjs --dirs "dir1,dir2"             # comma-separated scan dirs
 *   node scan-plans.mjs /path/to/dir /other/path       # positional = scan dirs too
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve, basename, relative } from 'node:path';

/* ── helpers ────────────────────────────────────────────────────────── */

function extractAnchorMap(html) {
  const marker = 'id="pf-anchor-map">';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  if (jsonEnd === -1) return null;
  try {
    return JSON.parse(html.slice(jsonStart, jsonEnd));
  } catch {
    return null;
  }
}

function isPresentPlan(html) {
  return html.includes('<meta name="generator" content="local-presentation"');
}

function chapterLabels(anchors) {
  if (!anchors) return [];
  return Object.values(anchors)
    .filter(a => a.kind === 'chapter')
    .map(a => a.label);
}

function statusFromSource(sourcePath) {
  if (!sourcePath || !existsSync(sourcePath)) return null;
  try {
    const src = readFileSync(sourcePath, 'utf8');
    const fm = src.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return null;
    const statusLine = fm[1].split('\n').find(l => l.startsWith('status:'));
    if (!statusLine) return null;
    return statusLine.replace('status:', '').trim();
  } catch {
    return null;
  }
}

async function findHtmlFiles(dirs) {
  const files = [];
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isFile() && e.name.endsWith('.html')) {
        files.push(full);
      } else if (e.isDirectory() && e.name !== 'node_modules') {
        await walk(full);
      }
    }
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    await walk(dir);
  }
  return files;
}

function loadDb(dbPath) {
  if (!existsSync(dbPath)) return [];
  try {
    const raw = readFileSync(dbPath, 'utf8');
    const db = JSON.parse(raw);
    return db.plans || [];
  } catch {
    return [];
  }
}

/* ── main ───────────────────────────────────────────────────────────── */

export async function scan({ dbPath, dirs } = {}) {
  const scanDirs = (dirs && dirs.length > 0)
    ? dirs
    : [resolve('.visual-plans')];
  const resolvedDbPath = dbPath || resolve('db.json');

  const htmlFiles = await findHtmlFiles(scanDirs);
  const existing = loadDb(resolvedDbPath);
  const seen = new Set();
  const plans = [];

  for (const filePath of htmlFiles) {
    const html = readFileSync(filePath, 'utf8');
    if (!isPresentPlan(html)) continue;

    const map = extractAnchorMap(html);
    if (!map) continue;

    const id = map.docId;
    seen.add(id);
    const htmlAbs = resolve(filePath);
    const old = existing.find(p => p.id === id);

    plans.push({
      id,
      title: map.title || (old && old.title) || basename(filePath, '.html'),
      source: map.source || (old && old.source) || null,
      html: htmlAbs,
      rendered_at: map.renderedAt || null,
      status: statusFromSource(map.source) || (old && old.status) || null,
      tags: (old && old.tags) || [],
      group: (old && old.group) || null,
      notes: (old && old.notes) || '',
      archived: (old && old.archived) || false,
      anchor_count: map.anchors ? Object.keys(map.anchors).length : 0,
      chapter_labels: chapterLabels(map.anchors),
    });
  }

  for (const p of existing) {
    if (!seen.has(p.id)) {
      plans.push({ ...p, _missing: true });
    }
  }

  const db = {
    version: 1,
    scanned_at: new Date().toISOString(),
    plans,
  };

  writeFileSync(resolvedDbPath, JSON.stringify(db, null, 2) + '\n');
  const cwd = process.cwd();
  const relPath = resolvedDbPath.startsWith(cwd + '/') ? relative(cwd, resolvedDbPath) : resolvedDbPath;
  console.log(`wrote ${plans.length} plans (${plans.filter(p => !p._missing).length} on disk) → ${relPath}`);
  return { total: plans.length, onDisk: plans.filter(p => !p._missing).length };
}

/* ── CLI ────────────────────────────────────────────────────────────── */

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const dirs = [];
  let dbPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && i + 1 < args.length) {
      dbPath = resolve(args[++i]);
    } else if (args[i] === '--dirs' && i + 1 < args.length) {
      for (const d of args[++i].split(',')) {
        const t = d.trim();
        if (t) dirs.push(resolve(t));
      }
    } else if (!args[i].startsWith('-')) {
      dirs.push(resolve(args[i]));
    }
  }

  scan({ dbPath, dirs }).catch(err => { console.error(err); process.exit(1); });
}
