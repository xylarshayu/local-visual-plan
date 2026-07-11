// render.mjs — the presentation engine's renderer.
//
// Turns a `plan.md` (see references/format.md) into a single self-contained,
// offline, interactive HTML document. Zero npm install: the only dependency is
// the vendored `marked`. Mermaid is NOT used in Node; it is inlined into the
// output and runs in the browser.
//
// Programmatic API:
//   renderPlan(markdownSource, { lean = false, sourcePath = null })
//     => { html, title, slug, warnings, docId }
//
// CLI:
//   node render.mjs <plan.md> [--out <path>] [--lean] [--open] [--no-open]

import { readFileSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { marked } from "./vendor/marked.esm.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ========================================================================== *
 *  Escaping
 * ========================================================================== */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Escape but allow it inside an attribute value too (same set is sufficient).
const esc = escapeHtml;

/* ========================================================================== *
 *  Frontmatter
 * ========================================================================== */

function parseFrontmatter(src) {
  const fm = { title: "", objective: "", status: "" };
  let body = src;
  // bodyOffset: 0-based index, in the ORIGINAL source's line array, of the first
  // line of `body`. Custom-block / chapter line ranges are computed relative to
  // this so anchor-map line numbers count from the top of plan.md (frontmatter
  // included), as the contract requires.
  let bodyOffset = 0;
  // Leading --- ... --- block of simple key: value lines.
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (const line of lines) {
      const km = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (!km) continue;
      const key = km[1].toLowerCase();
      let val = km[2].trim();
      // strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key === "title" || key === "objective" || key === "status") fm[key] = val;
    }
    body = src.slice(m[0].length);
    bodyOffset = (m[0].match(/\n/g) || []).length;
  }
  return { frontmatter: fm, body, bodyOffset };
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "plan";
}

/* ========================================================================== *
 *  Anchors, source-map & doc identity (feedback plumbing)
 *
 *  Every addressable element carries data-pf-anchor="<anchor>" AND id="<anchor>".
 *  Anchor grammar:  <kind>:<slug>   or   <kind>:<slug>:<n>  (n>=2 on collision,
 *  in document order). Diff hunks:  <parent-diff-anchor>:h<i>  (1-based).
 *  A JSON anchor-map + the base64 plan.md source are baked into the output so a
 *  reviewer's notes resolve straight back to plan.md line ranges.
 * ========================================================================== */

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, "");
}

// Decode only the handful of entities `marked`/our escaper emit, so slugs and
// human labels read naturally ("All & Both", not "all-amp-both"). &amp; last.
function decodeEntitiesLite(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// Locate markdown headings in the RAW source (outside fenced blocks) so prose
// heading anchors can carry a real plan.md line number. Step/question titles use
// `# ` too, but those live INSIDE fenced blocks, so fence tracking excludes them.
function collectSourceHeadings(source) {
  const lines = String(source).split(/\r?\n/);
  const heads = [];
  let fenceChar = null, fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fm) {
      const ch = fm[1][0], len = fm[1].length;
      if (!fenceChar) { fenceChar = ch; fenceLen = len; }
      else if (ch === fenceChar && len >= fenceLen) { fenceChar = null; fenceLen = 0; }
      continue;
    }
    if (fenceChar) continue;
    const hm = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (hm) heads.push({ line: i + 1, slug: slugify(decodeEntitiesLite(hm[1])), used: false });
  }
  return heads;
}

function findHeadingLines(reg, text) {
  const slug = slugify(text);
  for (const h of reg.headings) {
    if (!h.used && h.slug === slug) { h.used = true; return [h.line, h.line]; }
  }
  return null;
}

function createRegistry(source, sourcePath, title) {
  return {
    source: String(source),
    sourcePath: sourcePath || null,
    title: title || "",
    counts: new Map(),                 // base "kind:slug" -> times seen (collision counter)
    anchors: {},                       // anchor -> { kind, label, lines }
    order: [],                         // registration order (document-ish order)
    typeIndex: Object.create(null),    // kind -> running int for fallback slugs
    headings: collectSourceHeadings(source),
  };
}

function nextTypeIndex(reg, kind) {
  reg.typeIndex[kind] = (reg.typeIndex[kind] || 0) + 1;
  return reg.typeIndex[kind];
}

// Assign a collision-numbered anchor and record it in the map. `lines` is a
// 1-based inclusive [start,end] into plan.md, or null when not statically known.
function registerAnchor(reg, kind, slugSource, label, lines) {
  const slug = slugify(slugSource || kind);
  const base = `${kind}:${slug}`;
  const n = (reg.counts.get(base) || 0) + 1;
  reg.counts.set(base, n);
  const anchor = n === 1 ? base : `${base}:${n}`;
  reg.anchors[anchor] = {
    kind,
    label: label != null ? String(label) : "",
    lines: Array.isArray(lines) && lines.length === 2 && lines[0] != null
      ? [lines[0], lines[1]] : null,
  };
  reg.order.push(anchor);
  return anchor;
}

// Diff hunks are pre-numbered (`:h<i>`), so they bypass collision counting but
// still land in the map for jump-to-line resolution.
function registerHunkAnchor(reg, anchor, label, lines) {
  reg.anchors[anchor] = {
    kind: "hunk",
    label: label != null ? String(label) : "",
    lines: Array.isArray(lines) && lines.length === 2 && lines[0] != null
      ? [lines[0], lines[1]] : null,
  };
  reg.order.push(anchor);
  return anchor;
}

// Register a pre-built hierarchical child anchor (e.g. `<block-anchor>:<entity>`)
// with an explicit kind. Mirrors registerHunkAnchor — it bypasses the base
// collision counter because the parent block anchor already disambiguates blocks
// — but still guards against an accidental duplicate id by appending `:n`.
function registerChildAnchor(reg, anchor, kind, label, lines) {
  let a = anchor;
  if (reg.anchors[a] !== undefined) {
    let n = 2;
    while (reg.anchors[`${anchor}:${n}`] !== undefined) n++;
    a = `${anchor}:${n}`;
  }
  reg.anchors[a] = {
    kind,
    label: label != null ? String(label) : "",
    lines: Array.isArray(lines) && lines.length === 2 && lines[0] != null
      ? [lines[0], lines[1]] : null,
  };
  reg.order.push(a);
  return a;
}

function computeDocId(source) {
  return "pf-" + createHash("sha256").update(String(source), "utf8").digest("hex").slice(0, 12);
}

// The exact plan.md bytes, base64'd — makes every page self-describing and
// re-renderable. base64 can never contain "</", so it cannot terminate the tag.
function embeddedSourceScript(source) {
  const b64 = Buffer.from(String(source), "utf8").toString("base64");
  return `<script type="application/octet-stream" id="pf-source" data-encoding="base64">${b64}</script>`;
}

// anchor -> {kind,label,lines} map, plus docId/source/title. "</" is escaped as
// "<\/" (a valid JSON solidus escape) so the JSON can never close the <script>.
function anchorMapScript(reg, docId) {
  const map = {
    version: 1,
    docId,
    source: reg.sourcePath,
    title: reg.title,
    anchors: reg.anchors,
  };
  const json = JSON.stringify(map).replace(/<\//g, "<\\/");
  return `<script type="application/json" id="pf-anchor-map">${json}</script>`;
}

/* ========================================================================== *
 *  Block info-string parsing
 * ========================================================================== */

const KNOWN_BLOCKS = new Set([
  "steps", "filetree", "diff", "code", "diagram", "wireframe", "questions", "callout",
  "data-model", "api-endpoint",
]);

// Parse `type key=value key="quoted value"` into { type, attrs }.
function parseInfo(info) {
  const trimmed = info.trim();
  if (!trimmed) return { type: "", attrs: {} };
  const type = trimmed.split(/\s+/, 1)[0];
  const rest = trimmed.slice(type.length);
  const attrs = {};
  // Quoted values may contain spaces. An unquoted value runs to the next space
  // but MUST NOT span an `=` (so `lang= file=src/x.ts` parses as an empty `lang`
  // and a separate `file`, rather than `lang` swallowing the next key=value).
  // The value is optional, so a bare `lang=` yields an empty string.
  const re = /([\w-]+)=("([^"]*)"|'([^']*)'|([^\s=]*))/g;
  let m;
  while ((m = re.exec(rest))) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
  }
  return { type, attrs };
}

/* ========================================================================== *
 *  Per-block renderers
 * ========================================================================== */

function renderSteps(body, ctx) {
  const lines = body.split(/\r?\n/);
  const steps = [];
  let cur = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx].replace(/\s+$/, "");
    if (!line.trim()) continue;
    const titleM = /^#\s+(.*)$/.exec(line);
    if (titleM) {
      cur = { title: titleM[1].trim(), files: [], why: [], startIdx: idx, endIdx: idx };
      steps.push(cur);
      continue;
    }
    if (!cur) {
      // body before any step title — start an untitled step so nothing is lost
      cur = { title: "", files: [], why: [], startIdx: idx, endIdx: idx };
      steps.push(cur);
    }
    cur.endIdx = idx;
    const fileM = /^(reuse|edit|new|delete)\s+(\S+)(?:\s+—\s+(.*)|\s+--\s+(.*))?\s*$/.exec(line.trim());
    if (fileM) {
      cur.files.push({
        change: fileM[1],
        path: fileM[2],
        note: (fileM[3] || fileM[4] || "").trim(),
      });
      continue;
    }
    const whyM = /^>\s?(.*)$/.exec(line.trim());
    if (whyM) {
      cur.why.push(whyM[1].trim());
      continue;
    }
    // Unrecognized line: treat as rationale so content is never dropped.
    cur.why.push(line.trim());
  }

  let out = '<ol data-block="steps">';
  for (const s of steps) {
    const lines2 = ctx.bodyStartLine != null
      ? [ctx.bodyStartLine + s.startIdx, ctx.bodyStartLine + s.endIdx] : null;
    const anchor = registerAnchor(ctx.reg, "step", s.title || "step", s.title, lines2);
    out += `<li class="step" data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">`;
    out += `<p class="step-title">${esc(s.title)}</p>`;
    if (s.files.length) {
      out += '<ul class="step-files">';
      for (const f of s.files) {
        out += `<li data-change="${esc(f.change)}">`;
        out += `<span class="change-tag">${esc(f.change)}</span>`;
        out += `<code class="file-path">${esc(f.path)}</code>`;
        if (f.note) out += `<span class="file-note">${esc(f.note)}</span>`;
        out += "</li>";
      }
      out += "</ul>";
    }
    if (s.why.length) {
      out += '<div class="step-why">';
      for (const w of s.why) out += `<p>${esc(w)}</p>`;
      out += "</div>";
    }
    out += "</li>";
  }
  out += "</ol>";
  return out;
}

const FLAG_TO_CHANGE = { "+": "added", "~": "modified", "-": "deleted", ".": "unchanged" };

function renderFiletree(body, ctx) {
  const lines = body.split(/\r?\n/);
  let out = '<div data-block="filetree"><ul>';
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (!raw.trim()) continue;
    // indentation: leading spaces (2 per level), before the flag char
    const indentM = /^(\s*)(\S)\s+(.*)$/.exec(raw);
    if (!indentM) continue;
    const depth = Math.floor(indentM[1].replace(/\t/g, "  ").length / 2);
    const flag = indentM[2];
    const change = FLAG_TO_CHANGE[flag] || "unchanged";
    let rest = indentM[3];
    let note = "";
    const noteM = /^(.*?)\s+(?:—|--)\s+(.*)$/.exec(rest);
    if (noteM) { rest = noteM[1]; note = noteM[2].trim(); }
    const path = rest.trim();
    const displayFlag = flag === "." ? "" : flag;
    const lines2 = ctx.bodyStartLine != null
      ? [ctx.bodyStartLine + idx, ctx.bodyStartLine + idx] : null;
    const anchor = registerAnchor(ctx.reg, "file", path, path, lines2);
    out += `<li class="tree-row" data-change="${change}" data-depth="${depth}" data-flag="${esc(displayFlag)}"`;
    out += ` data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}"`;
    out += ` style="padding-left:${10 + depth * 18}px">`;
    out += `<span class="tree-path">${esc(path)}</span>`;
    if (note) out += `<span class="tree-note">${esc(note)}</span>`;
    out += "</li>";
  }
  out += "</ul></div>";
  return out;
}

// Parse a unified diff body into hunks of typed lines, capturing @note lines.
function parseDiff(body) {
  const lines = body.split(/\r?\n/);
  const rows = []; // { type:'hunk'|'add'|'del'|'ctx'|'note', text, oldNo, newNo, srcIdx }
  let oldNo = 0, newNo = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const noteM = /^@note:\s?(.*)$/.exec(raw);
    if (noteM) { rows.push({ type: "note", text: noteM[1] }); continue; }
    const hunkM = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/.exec(raw);
    if (hunkM) {
      oldNo = parseInt(hunkM[1], 10);
      newNo = parseInt(hunkM[2], 10);
      rows.push({ type: "hunk", text: raw, srcIdx: idx });
      continue;
    }
    if (raw.startsWith("+")) { rows.push({ type: "add", text: raw.slice(1), newNo: newNo++ }); continue; }
    if (raw.startsWith("-")) { rows.push({ type: "del", text: raw.slice(1), oldNo: oldNo++ }); continue; }
    // context (leading space, or any other line we keep verbatim)
    const text = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (raw === "" ) { /* skip pure blank lines between hunks */ continue; }
    rows.push({ type: "ctx", text, oldNo: oldNo++, newNo: newNo++ });
  }
  return rows;
}

function renderDiffUnified(rows) {
  let out = '<div class="diff-body"><table class="diff-table"><tbody>';
  for (const r of rows) {
    if (r.type === "note") {
      out += `<tr class="diff-line"><td colspan="3" class="diff-note">${esc(r.text)}</td></tr>`;
      continue;
    }
    if (r.type === "hunk") {
      const a = r.hunkAnchor ? ` data-pf-anchor="${esc(r.hunkAnchor)}" id="${esc(r.hunkAnchor)}"` : "";
      out += `<tr class="diff-line" data-line="hunk"${a}><td colspan="3">${esc(r.text)}</td></tr>`;
      continue;
    }
    const sign = r.type === "add" ? "+" : r.type === "del" ? "-" : " ";
    const oldCell = r.type === "add" ? "" : (r.oldNo ?? "");
    const newCell = r.type === "del" ? "" : (r.newNo ?? "");
    out += `<tr class="diff-line" data-line="${r.type}">`;
    out += `<td class="diff-gutter diff-gutter-old">${oldCell}</td>`;
    out += `<td class="diff-gutter diff-gutter-new">${newCell}</td>`;
    out += `<td class="diff-code"><span class="diff-sign">${sign}</span>${esc(r.text)}</td>`;
    out += "</tr>";
  }
  out += "</tbody></table></div>";
  return out;
}

function renderDiffSplit(rows) {
  // Build paired left (old) / right (new) rows. Notes and hunks span both.
  let out = '<div class="diff-body diff-split">';
  // We render two synchronized tables side by side, row by row.
  // Simpler: one grid of two panes, each its own table, with paired rows.
  const left = []; // {type, text, no}
  const right = [];
  // We must keep them row-aligned. Walk rows, queueing dels then adds.
  let i = 0;
  function pushPair(l, r) { left.push(l); right.push(r); }
  while (i < rows.length) {
    const r = rows[i];
    if (r.type === "hunk" || r.type === "note") {
      // The hunk anchor rides ONLY the left pane's row so the id stays unique
      // (both panes render the same hunk header).
      pushPair({ type: r.type, text: r.text, hunkAnchor: r.hunkAnchor }, { type: r.type, text: r.text });
      i++;
      continue;
    }
    if (r.type === "ctx") {
      pushPair({ type: "ctx", text: r.text, no: r.oldNo }, { type: "ctx", text: r.text, no: r.newNo });
      i++;
      continue;
    }
    // collect a run of dels then a run of adds, then pair them up
    const dels = [];
    const adds = [];
    while (i < rows.length && rows[i].type === "del") { dels.push(rows[i]); i++; }
    while (i < rows.length && rows[i].type === "add") { adds.push(rows[i]); i++; }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const d = dels[k];
      const a = adds[k];
      pushPair(
        d ? { type: "del", text: d.text, no: d.oldNo } : { type: "empty", text: "" },
        a ? { type: "add", text: a.text, no: a.newNo } : { type: "empty", text: "" }
      );
    }
    if (n === 0 && dels.length === 0 && adds.length === 0) i++; // safety
  }

  function renderPane(rowsArr, head) {
    let p = `<div class="diff-pane"><div class="diff-pane-head">${head}</div><table class="diff-table"><tbody>`;
    for (const row of rowsArr) {
      if (row.type === "hunk") {
        const a = row.hunkAnchor ? ` data-pf-anchor="${esc(row.hunkAnchor)}" id="${esc(row.hunkAnchor)}"` : "";
        p += `<tr class="diff-line" data-line="hunk"${a}><td colspan="2">${esc(row.text)}</td></tr>`;
        continue;
      }
      if (row.type === "note") {
        p += `<tr class="diff-line"><td colspan="2" class="diff-note">${esc(row.text)}</td></tr>`;
        continue;
      }
      if (row.type === "empty") {
        p += `<tr class="diff-line diff-empty"><td class="diff-gutter"></td><td class="diff-code"></td></tr>`;
        continue;
      }
      const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
      p += `<tr class="diff-line" data-line="${row.type}">`;
      p += `<td class="diff-gutter">${row.no ?? ""}</td>`;
      p += `<td class="diff-code"><span class="diff-sign">${sign}</span>${esc(row.text)}</td>`;
      p += "</tr>";
    }
    p += "</tbody></table></div>";
    return p;
  }

  out += renderPane(left, "Before");
  out += renderPane(right, "After");
  out += "</div>";
  return out;
}

function renderDiff(body, attrs, ctx) {
  const reg = ctx.reg;
  const mode = attrs.mode === "split" ? "split" : "unified";
  const rows = parseDiff(body);
  const idx = nextTypeIndex(reg, "diff");
  const slugSrc = attrs.file || `diff-${idx}`;
  const label = attrs.file || `diff ${idx}`;
  const figAnchor = registerAnchor(reg, "diff", slugSrc, label, ctx.blockLines);
  // Number hunks (1-based) and register each `<diffAnchor>:h<i>` with its line.
  let hi = 0;
  for (const r of rows) {
    if (r.type !== "hunk") continue;
    hi++;
    const hAnchor = `${figAnchor}:h${hi}`;
    const hLines = ctx.bodyStartLine != null && r.srcIdx != null
      ? [ctx.bodyStartLine + r.srcIdx, ctx.bodyStartLine + r.srcIdx] : null;
    registerHunkAnchor(reg, hAnchor, `${label} · hunk ${hi}`, hLines);
    r.hunkAnchor = hAnchor;
  }
  let out = `<figure data-block="diff" data-mode="${mode}" data-pf-anchor="${esc(figAnchor)}" id="${esc(figAnchor)}">`;
  if (attrs.file) out += `<figcaption>${esc(attrs.file)}</figcaption>`;
  out += mode === "split" ? renderDiffSplit(rows) : renderDiffUnified(rows);
  out += "</figure>";
  return out;
}

function parseHlRanges(spec) {
  const set = new Set();
  if (!spec) return set;
  for (const part of String(spec).split(",")) {
    const range = part.trim();
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(range);
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      for (let n = Math.min(a, b); n <= Math.max(a, b); n++) set.add(n);
    } else if (/^\d+$/.test(range)) {
      set.add(parseInt(range, 10));
    }
  }
  return set;
}

// Tiny, dependency-free, per-line syntax highlighter for `code` blocks. Not a
// full tokenizer — it tags comments, strings, numbers, and a broad union of
// keywords with regex, escaping everything. Multi-line constructs (block
// comments / template literals spanning lines) are not tracked across lines,
// which is fine for the short snippets a plan/recap shows.
const HASH_LANGS = new Set([
  "py", "python", "sh", "bash", "zsh", "shell", "yaml", "yml", "ruby", "rb",
  "toml", "ini", "nginx", "dockerfile", "makefile", "hcl", "r", "perl", "pl", "conf",
]);
const KEYWORDS = new Set(
  ("const let var function return if else for while do switch case break continue " +
   "import export from as default class extends implements interface type enum new " +
   "this super async await yield throw try catch finally typeof instanceof in of void " +
   "delete public private protected readonly static abstract def lambda pass elif None " +
   "True False nil null true false undefined fn impl use pub mut match mod struct trait " +
   "where package func defer select chan map range end then local require module namespace " +
   "and or not is").split(" "));

function highlightLine(line, lang) {
  const hash = HASH_LANGS.has((lang || "").toLowerCase());
  let out = "", i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    let m =
      /^\/\/.*/.exec(rest) ||
      (hash ? /^#.*/.exec(rest) : null) ||
      /^\/\*[\s\S]*?\*\//.exec(rest) ||
      /^<!--[\s\S]*?-->/.exec(rest);
    if (m) { out += `<span class="tok-comment">${esc(m[0])}</span>`; i += m[0].length; continue; }
    m = /^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'|^`(?:[^`\\]|\\.)*`/.exec(rest);
    if (m) { out += `<span class="tok-string">${esc(m[0])}</span>`; i += m[0].length; continue; }
    m = /^(?:0[xX][\da-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?)\b/.exec(rest);
    if (m) { out += `<span class="tok-number">${esc(m[0])}</span>`; i += m[0].length; continue; }
    m = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (m) { out += KEYWORDS.has(m[0]) ? `<span class="tok-keyword">${esc(m[0])}</span>` : esc(m[0]); i += m[0].length; continue; }
    m = /^\s+|^[\s\S]/.exec(rest);
    out += esc(m[0]); i += m[0].length;
  }
  return out;
}

function renderCode(body, attrs, ctx) {
  const reg = ctx.reg;
  const lang = attrs.lang || "";
  const codeIdx = nextTypeIndex(reg, "code");
  const slugSrc = attrs.file || (lang ? `${lang}-${codeIdx}` : `code-${codeIdx}`);
  const label = attrs.file || (lang ? `${lang} snippet ${codeIdx}` : `code ${codeIdx}`);
  const anchor = registerAnchor(reg, "code", slugSrc, label, ctx.blockLines);
  const hl = parseHlRanges(attrs.hl);
  const lines = body.split(/\r?\n/);
  // Strip leading @note line=N: lines from the top of the body.
  const notes = new Map(); // lineNo -> [texts]
  let idx = 0;
  while (idx < lines.length) {
    const m = /^@note\s+line=(\d+)\s*:\s?(.*)$/.exec(lines[idx]);
    if (!m) break;
    const n = parseInt(m[1], 10);
    if (!notes.has(n)) notes.set(n, []);
    notes.get(n).push(m[2]);
    idx++;
  }
  let codeLines = lines.slice(idx);
  // Drop a single trailing empty line (from the closing fence newline).
  if (codeLines.length && codeLines[codeLines.length - 1] === "") codeLines.pop();

  let out = `<figure data-block="code" data-lang="${esc(lang)}" data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">`;
  if (attrs.file || lang) {
    out += '<figcaption>';
    out += `<span class="code-file">${esc(attrs.file || "")}</span>`;
    if (lang) out += `<span class="code-lang">${esc(lang)}</span>`;
    out += "</figcaption>";
  }
  out += '<ol class="code-lines">';
  codeLines.forEach((ln, i) => {
    const num = i + 1;
    const hlAttr = hl.has(num) ? ' data-hl="1"' : "";
    out += `<li${hlAttr}><span class="code-text">${highlightLine(ln, lang) || "&#8203;"}</span></li>`;
    if (notes.has(num)) {
      for (const t of notes.get(num)) {
        out += `<li class="code-note"><span class="code-note-body">${esc(t)}</span></li>`;
      }
    }
  });
  out += "</ol></figure>";
  return out;
}

// Each diagram declares its OWN look via Mermaid YAML frontmatter prepended to
// the source. This is reliable and deterministic: relying on a single global
// mermaid.initialize({look}) proved flaky — with two render passes at startup, a
// diagram would sometimes come out classic instead of hand-drawn. We do NOT set
// a per-diagram fontFamily: Mermaid measures node width with the GLOBAL font
// (Virgil) and must also render with it, or labels clip. So both looks keep the
// global Virgil font; only the SHAPE differs (handDrawn = sketchy via rough.js,
// classic = crisp). If the author wrote their own frontmatter / `%%{init}%%`,
// leave it untouched — they own the config.
function withDiagramFrontmatter(src, look) {
  const trimmed = src.replace(/\s+$/, "");
  if (/^﻿?\s*(?:---|%%\{)/.test(trimmed)) return trimmed; // author owns config
  const value = look === "clean" ? "classic" : "handDrawn";
  return `---\nconfig:\n  look: ${value}\n---\n` + trimmed;
}

function renderDiagram(body, attrs, lean, ctx) {
  const reg = ctx.reg;
  const look = attrs.look === "clean" ? "clean" : "handDrawn";
  const idx = nextTypeIndex(reg, "diagram");
  const slugSrc = attrs.title || `diagram-${idx}`;
  const label = attrs.title || `diagram ${idx}`;
  const anchor = registerAnchor(reg, "diagram", slugSrc, label, ctx.blockLines);
  let out = `<figure data-block="diagram" data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">`;
  if (attrs.title) out += `<figcaption>${esc(attrs.title)}</figcaption>`;
  if (lean) {
    out += `<pre class="diagram-lean"><code>${esc(body.replace(/\s+$/, ""))}</code></pre>`;
  } else {
    // Raw mermaid source (with the look frontmatter); escaped so browser-side
    // mermaid receives text, not parsed HTML. Mermaid reads textContent, so the
    // entities decode back. `data-look` lets renderPlan know a font is needed.
    const source = withDiagramFrontmatter(body, look);
    out += `<pre class="mermaid" data-look="${look}">${esc(source)}</pre>`;
  }
  out += "</figure>";
  return out;
}

const SURFACES = new Set(["page", "panel", "popover", "sheet", "toolbar"]);

function renderWireframe(body, attrs, ctx) {
  const reg = ctx.reg;
  const surface = SURFACES.has(attrs.surface) ? attrs.surface : "page";
  const sketchy = attrs.style === "sketchy";
  const idx = nextTypeIndex(reg, "wireframe");
  const slugSrc = attrs.title || `wireframe-${idx}`;
  const label = attrs.title || `wireframe ${idx}`;
  const anchor = registerAnchor(reg, "wireframe", slugSrc, label, ctx.blockLines);
  let out = `<figure data-block="wireframe" data-surface="${surface}" data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">`;
  if (attrs.title) out += `<figcaption>${esc(attrs.title)}</figcaption>`;
  const sketchClass = sketchy ? " is-sketchy" : "";
  // The toolbar surface frame is `.wf-toolbar-surface` ONLY — emitting the bare
  // `wf-toolbar` here would apply the body-element `.wf-toolbar` styling (sunken
  // bg / border-bottom) to the surface chrome. Every other surface uses its own
  // unique `wf-<surface>` frame class (see wireframe.md frame-class table).
  const frameClass = surface === "toolbar" ? "wf-toolbar-surface" : `wf-${surface}`;
  // wireframe bodies are intentionally passed through as raw HTML (trusted).
  out += `<div class="wf-screen ${frameClass}${sketchClass}">${body.replace(/^\s*\n/, "").replace(/\n\s*$/, "")}</div>`;
  out += "</figure>";
  return out;
}

function renderQuestions(body, ctx) {
  const lines = body.split(/\r?\n/);
  const qs = [];
  let cur = null;
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (!raw.trim()) continue;
    const qM = /^#\s+(.*)$/.exec(raw.trim());
    if (qM) { cur = { text: qM[1].trim(), def: "", startIdx: idx, endIdx: idx }; qs.push(cur); continue; }
    const dM = /^default:\s?(.*)$/i.exec(raw.trim());
    if (dM && cur) { cur.def = dM[1].trim(); cur.endIdx = idx; continue; }
    if (cur) { cur.text += " " + raw.trim(); cur.endIdx = idx; }
  }
  let out = '<div data-block="questions">';
  for (const q of qs) {
    const lines2 = ctx.bodyStartLine != null
      ? [ctx.bodyStartLine + q.startIdx, ctx.bodyStartLine + q.endIdx] : null;
    const anchor = registerAnchor(ctx.reg, "q", q.text, q.text, lines2);
    out += `<div class="question" data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">`;
    out += `<p class="q-text">${esc(q.text)}</p>`;
    if (q.def) out += `<p class="q-default">${esc(q.def)}</p>`;
    // Interactive answer form: default is pre-selected; the custom textarea is
    // hidden by CSS until the "custom" radio is checked. The annotate script
    // reads these to build the export; without JS the form is simply inert.
    out += '<div class="q-form">';
    out += `<label><input type="radio" name="${esc(anchor)}" value="default" checked> Accept default</label>`;
    out += `<label><input type="radio" name="${esc(anchor)}" value="custom"> Answer differently</label>`;
    out += '<textarea class="q-custom" placeholder="Your answer…"></textarea>';
    out += "</div>";
    out += "</div>";
  }
  out += "</div>";
  return out;
}

const CALLOUT_TONES = new Set(["info", "decision", "warning", "risk"]);

// `callout` — a labeled aside for decisions / warnings / risks. Body is markdown
// (rendered via marked + remote-ref neutralization, like prose); the callout
// itself is the addressable element (its inner paragraphs are not separately
// anchored).
function renderCallout(body, attrs, ctx) {
  const reg = ctx.reg;
  const tone = CALLOUT_TONES.has(attrs.tone) ? attrs.tone : "info";
  const idx = nextTypeIndex(reg, "callout");
  const slugSrc = attrs.title || `${tone}-${idx}`;
  const label = attrs.title || `${tone} callout ${idx}`;
  const anchor = registerAnchor(reg, "callout", slugSrc, label, ctx.blockLines);
  const inner = neutralizeRemoteRefs(marked.parse(body.replace(/\s+$/, "")));
  let out = `<aside data-block="callout" data-tone="${tone}" data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">`;
  if (attrs.title) out += `<p class="callout-title">${escapeHtml(attrs.title)}</p>`;
  out += `<div class="callout-body">${inner}</div>`;
  out += "</aside>";
  return out;
}

/* ========================================================================== *
 *  data-model + api-endpoint — shared change-annotation helpers
 * ========================================================================== */

// Split a trailing ` — note` / ` -- note` off a line (same convention as
// filetree/steps). Returns { head, note } with note === "" when absent. The
// non-greedy head splits on the FIRST separator; a bare `->` never matches the
// `--` alternative (it needs two hyphens), so an `FK -> target` survives intact.
function splitTrailingNote(s) {
  const m = /^(.*?)\s+(?:—|--)\s+(.*)$/.exec(s);
  if (m) return { head: m[1].trim(), note: m[2].trim() };
  return { head: String(s).trim(), note: "" };
}

// A note beginning `was:` is a "previous value" — surfaced struck-through beside
// the field rather than as an ordinary note. Returns { was, note } (one is "").
function classifyNote(note) {
  const m = /^was:\s*(.*)$/i.exec(note);
  if (m) return { was: m[1].trim(), note: "" };
  return { was: "", note };
}

/* ========================================================================== *
 *  data-model — entity/field cards with change flags + relations
 * ========================================================================== */

// A Mermaid-ER cardinality token: a `--` core hugged by `|o{}` decorations on
// each side (e.g. `}o--||`, `||--o{`). The decoration chars must sit immediately
// against the `--`, so a plain ` -- note` separator can never look like one.
const DM_CARD_RE = /[|o{}]{1,2}--[|o{}]{1,2}/;

// Parse a field head (name + type tokens + an optional PK/FK key). `<type…>` is
// everything between the name and the first of PK / FK (the trailing note has
// already been stripped). FK carries its `-> target`.
function parseFieldHead(head) {
  const tokens = String(head).split(/\s+/).filter(Boolean);
  const name = tokens.shift() || "";
  let key = null;
  const typeTokens = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "PK") { key = { kind: "pk" }; break; }
    if (t === "FK") {
      const target = tokens.slice(i + 1).join(" ").replace(/^->\s*/, "").trim().split(/\s+/)[0] || "";
      key = { kind: "fk", target };
      break;
    }
    typeTokens.push(t);
  }
  return { name, type: typeTokens.join(" "), key };
}

function renderDataModel(body, attrs, ctx) {
  const reg = ctx.reg;
  const idx = nextTypeIndex(reg, "data-model");
  const slugSrc = attrs.title || `data-model-${idx}`;
  const label = attrs.title || `data model ${idx}`;
  const blockAnchor = registerAnchor(reg, "data-model", slugSrc, label, ctx.blockLines);

  const lines = body.split(/\r?\n/);
  const items = [];      // entity cards + top-level raw lines, in document order
  const relations = [];
  let cur = null;        // current entity accumulating fields

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const lineNo = ctx.bodyStartLine != null ? ctx.bodyStartLine + i : null;
    const content = raw.trim();

    // RELATION — an indent-0 line carrying a Mermaid-ER cardinality token. Neither
    // an entity nor a field ever contains one, so this is unambiguous.
    if (DM_CARD_RE.test(content)) {
      const rm = /^(\S+)\s+([|o{}]{1,2}--[|o{}]{1,2})\s+(\S+)(?:\s*:\s*(.*))?$/.exec(content);
      relations.push(rm
        ? { lhs: rm[1], card: rm[2], rhs: rm[3], label: (rm[4] || "").trim() }
        : { raw: true, text: content });
      continue;
    }

    // ENTITY vs FIELD. The flag sits at column 0 for BOTH; the distinction is the
    // gap to the name: an entity uses a single space (`. user`), a field indents
    // the name ≥2 spaces (`~   plan_id …`). Leading indent before the flag also
    // marks a field.
    const m = /^([ \t]*)([+~\-.])([ \t]+)(.*)$/.exec(raw.replace(/\s+$/, ""));
    if (m) {
      const flag = m[2];
      const leadBefore = m[1].replace(/\t/g, "  ").length;
      const spacesAfter = m[3].replace(/\t/g, "  ").length;
      const rest = m[4];
      const isField = leadBefore >= 2 || spacesAfter >= 2;

      if (isField && cur) {
        const { head, note } = splitTrailingNote(rest);
        const { was, note: plainNote } = classifyNote(note);
        const parsed = parseFieldHead(head);
        const fAnchor = registerChildAnchor(
          reg, `${blockAnchor}:${slugify(cur.name + "." + parsed.name)}`,
          "field", `${cur.name}.${parsed.name}`, [lineNo, lineNo]);
        cur.fields.push({ change: FLAG_TO_CHANGE[flag] || "unchanged", ...parsed, was, note: plainNote, anchor: fAnchor });
        continue;
      }
      if (isField) {          // a field with no owning entity — preserve verbatim
        items.push({ raw: true, text: content });
        continue;
      }
      // ENTITY
      const { head, note } = splitTrailingNote(rest);
      const { was, note: plainNote } = classifyNote(note);
      const eAnchor = registerChildAnchor(
        reg, `${blockAnchor}:${slugify(head)}`, "entity", head, [lineNo, lineNo]);
      cur = { change: FLAG_TO_CHANGE[flag] || "unchanged", name: head, was, note: plainNote, fields: [], anchor: eAnchor };
      items.push(cur);
      continue;
    }
    items.push({ raw: true, text: content });
  }

  let out = `<figure data-block="data-model" data-pf-anchor="${esc(blockAnchor)}" id="${esc(blockAnchor)}">`;
  if (attrs.title) out += `<figcaption>${esc(attrs.title)}</figcaption>`;
  out += '<div class="dm-grid">';
  for (const e of items) {
    if (e.raw) { out += `<div class="dm-raw">${esc(e.text)}</div>`; continue; }
    out += `<div class="dm-entity" data-change="${e.change}" data-pf-anchor="${esc(e.anchor)}" id="${esc(e.anchor)}">`;
    out += `<div class="dm-entity-name">${esc(e.name)}</div>`;
    if (e.was || e.note) {
      out += '<div class="dm-entity-meta">';
      if (e.was) out += `<span class="dm-was">${esc(e.was)}</span>`;
      if (e.note) out += `<span class="dm-note">${esc(e.note)}</span>`;
      out += "</div>";
    }
    for (const f of e.fields) {
      if (f.raw) { out += `<div class="dm-field dm-raw">${esc(f.text)}</div>`; continue; }
      out += `<div class="dm-field" data-change="${f.change}" data-pf-anchor="${esc(f.anchor)}" id="${esc(f.anchor)}">`;
      out += `<span class="dm-field-name">${esc(f.name)}</span>`;
      if (f.type) out += `<span class="dm-field-type">${esc(f.type)}</span>`;
      if (f.key && f.key.kind === "pk") out += '<span class="dm-key" data-key="pk">PK</span>';
      else if (f.key && f.key.kind === "fk") out += `<span class="dm-key" data-key="fk">FK <span class="dm-fk-target">→ ${esc(f.key.target)}</span></span>`;
      if (f.was) out += `<span class="dm-was">${esc(f.was)}</span>`;
      if (f.note) out += `<span class="dm-note">${esc(f.note)}</span>`;
      out += "</div>";
    }
    out += "</div>";
  }
  out += "</div>";
  if (relations.length) {
    out += '<ul class="dm-relations">';
    for (const r of relations) {
      if (r.raw) { out += `<li class="dm-relation dm-raw">${esc(r.text)}</li>`; continue; }
      out += '<li class="dm-relation">';
      out += `<span class="dm-rel-entity">${esc(r.lhs)}</span>`;
      out += `<span class="dm-rel-card">${esc(r.card)}</span>`;
      out += `<span class="dm-rel-entity">${esc(r.rhs)}</span>`;
      if (r.label) out += `<span class="dm-rel-label">${esc(r.label)}</span>`;
      out += "</li>";
    }
    out += "</ul>";
  }
  out += "</figure>";
  return out;
}

/* ========================================================================== *
 *  api-endpoint — params + request/response JSON trees
 * ========================================================================== */

const API_INS = new Set(["path", "query", "header", "body", "auth"]);

function jsonPrimitive(value) {
  if (value === null) return { cls: "json-null", text: "null" };
  const t = typeof value;
  if (t === "string") return { cls: "json-string", text: JSON.stringify(value) };
  if (t === "number") return { cls: "json-number", text: String(value) };
  if (t === "boolean") return { cls: "json-bool", text: String(value) };
  return { cls: "json-unknown", text: String(value) };
}

// Server-side collapsible JSON tree (zero JS): nested <details>/<summary>.
// Top-level open; containers deeper than depth 2 collapsed by default. All text
// is escaped. Keys and primitive values carry type-differentiated classes.
function renderJsonNode(value, key, depth) {
  const keyHtml = key != null ? `<span class="json-key">${esc(String(key))}</span>` : "";
  const isContainer = value !== null && typeof value === "object";
  if (!isContainer) {
    const p = jsonPrimitive(value);
    return `<div class="json-row" data-depth="${depth}">${keyHtml}<span class="json-value ${p.cls}">${esc(p.text)}</span></div>`;
  }
  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  const preview = isArr ? `[ ${entries.length} ]` : `{ ${entries.length} }`;
  const open = depth <= 2 ? " open" : "";
  let out = `<details class="json-node" data-depth="${depth}"${open}>`;
  out += `<summary class="json-summary">${keyHtml}<span class="json-preview" data-kind="${isArr ? "array" : "object"}">${esc(preview)}</span></summary>`;
  out += '<div class="json-children">';
  for (const [k, v] of entries) out += renderJsonNode(v, k, depth + 1);
  out += "</div></details>";
  return out;
}

// Render a section body: a JSON tree, or — when JSON.parse fails — the raw text
// escaped in <pre class="api-raw"> with a "not valid JSON" hint. Never throws.
function renderJsonBody(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return '<div class="json-tree json-empty"></div>';
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return `<pre class="api-raw"><span class="api-raw-hint">not valid JSON</span>${esc(String(text).replace(/\s+$/, ""))}</pre>`;
  }
  return `<div class="json-tree">${renderJsonNode(parsed, null, 0)}</div>`;
}

function renderApiEndpoint(body, attrs, ctx) {
  const reg = ctx.reg;
  const idx = nextTypeIndex(reg, "api-endpoint");
  const method = attrs.method ? String(attrs.method) : "";
  const path = attrs.path ? String(attrs.path) : "";
  const methodUpper = method.toUpperCase();
  const slugSrc = (method && path) ? `${method} ${path}` : (attrs.title || `api-endpoint-${idx}`);
  const label = attrs.title || (method && path ? `${methodUpper} ${path}` : `api endpoint ${idx}`);
  const blockAnchor = registerAnchor(reg, "api-endpoint", slugSrc, label, ctx.blockLines);

  const lines = body.split(/\r?\n/);
  const params = [];
  const sections = [];
  let curSection = null;
  let inSections = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = ctx.bodyStartLine != null ? ctx.bodyStartLine + i : null;
    const trimmed = raw.trim();
    const reqM = /^request:\s*$/i.exec(trimmed);
    const respM = reqM ? null : /^response\s+(\S+?)\s*:\s*$/i.exec(trimmed);
    if (reqM || respM) {
      inSections = true;
      if (reqM) {
        const a = registerChildAnchor(reg, `${blockAnchor}:request`, "request", "request", [lineNo, lineNo]);
        curSection = { kind: "request", code: "", anchor: a, bodyLines: [] };
      } else {
        const code = respM[1];
        const a = registerChildAnchor(reg, `${blockAnchor}:resp-${slugify(code)}`, "response", `response ${code}`, [lineNo, lineNo]);
        curSection = { kind: "response", code, anchor: a, bodyLines: [] };
      }
      sections.push(curSection);
      continue;
    }
    if (inSections) { if (curSection) curSection.bodyLines.push(raw); continue; }
    if (!trimmed) continue;

    // PARAM — `<flag> <in> <rest…>`; a bad flag or unknown `<in>` degrades to raw.
    const pm = /^([+~\-.])\s+(\S+)\s*(.*)$/.exec(trimmed);
    if (pm && API_INS.has(pm[2].toLowerCase())) {
      const flag = pm[1];
      const inKind = pm[2].toLowerCase();
      const { head, note } = splitTrailingNote(pm[3]);
      const { was, note: plainNote } = classifyNote(note);
      let name = "", type = "", desc = "";
      if (inKind === "auth") {
        desc = head;           // free text (e.g. "Bearer org token")
        name = "auth";         // anchor slug source
      } else {
        const toks = head.split(/\s+/).filter(Boolean);
        name = toks.shift() || "";
        type = toks.join(" ");
      }
      const pAnchor = registerChildAnchor(
        reg, `${blockAnchor}:${slugify(inKind === "auth" ? "auth" : name)}`,
        "param", `${inKind} ${inKind === "auth" ? "auth" : name}`, [lineNo, lineNo]);
      params.push({ change: FLAG_TO_CHANGE[flag] || "unchanged", inKind, name, type, desc, was, note: plainNote, anchor: pAnchor });
    } else {
      params.push({ raw: true, text: trimmed });
    }
  }

  let out = `<figure data-block="api-endpoint" data-pf-anchor="${esc(blockAnchor)}" id="${esc(blockAnchor)}">`;
  if (attrs.title) out += `<figcaption>${esc(attrs.title)}</figcaption>`;
  out += '<div class="api-head">';
  if (methodUpper) out += `<span class="api-method" data-method="${esc(methodUpper)}">${esc(methodUpper)}</span>`;
  if (path) out += `<span class="api-path">${esc(path)}</span>`;
  out += "</div>";
  if (params.length) {
    out += '<div class="api-params">';
    for (const p of params) {
      if (p.raw) { out += `<div class="api-raw-line">${esc(p.text)}</div>`; continue; }
      out += `<div class="api-param" data-change="${p.change}" data-pf-anchor="${esc(p.anchor)}" id="${esc(p.anchor)}">`;
      out += `<span class="api-in" data-in="${esc(p.inKind)}">${esc(p.inKind)}</span>`;
      if (p.inKind === "auth") {
        if (p.desc) out += `<span class="api-param-name">${esc(p.desc)}</span>`;
      } else {
        out += `<span class="api-param-name">${esc(p.name)}</span>`;
        if (p.type) out += `<span class="api-param-type">${esc(p.type)}</span>`;
      }
      if (p.was) out += `<span class="api-was">${esc(p.was)}</span>`;
      if (p.note) out += `<span class="api-note">${esc(p.note)}</span>`;
      out += "</div>";
    }
    out += "</div>";
  }
  for (const s of sections) {
    const codeAttr = s.kind === "response" ? ` data-code="${esc(s.code)}"` : "";
    out += `<div class="api-section" data-section="${s.kind}"${codeAttr} data-pf-anchor="${esc(s.anchor)}" id="${esc(s.anchor)}">`;
    out += `<span class="api-code">${s.kind === "request" ? "REQUEST" : esc(s.code)}</span>`;
    out += renderJsonBody(s.bodyLines.join("\n"));
    out += "</div>";
  }
  out += "</figure>";
  return out;
}

function renderUnknown(type, body) {
  return `<pre data-block="unknown" data-type="${esc(type)}">${esc(body.replace(/\s+$/, ""))}</pre>`;
}

function renderBlock(type, attrs, body, lean, warnings, ctx) {
  switch (type) {
    case "steps": return renderSteps(body, ctx);
    case "filetree": return renderFiletree(body, ctx);
    case "diff": return renderDiff(body, attrs, ctx);
    case "code": return renderCode(body, attrs, ctx);
    case "diagram": return renderDiagram(body, attrs, lean, ctx);
    case "wireframe": return renderWireframe(body, attrs, ctx);
    case "questions": return renderQuestions(body, ctx);
    case "callout": return renderCallout(body, attrs, ctx);
    case "data-model": return renderDataModel(body, attrs, ctx);
    case "api-endpoint": return renderApiEndpoint(body, attrs, ctx);
    default:
      warnings.push(`unknown block type: ${type}`);
      return renderUnknown(type, body);
  }
}

/* ========================================================================== *
 *  Fence extraction + placeholders
 * ========================================================================== */

// Wrap the placeholder token in non-printing sentinel bytes (\x01 … \x02) so it
// can never collide with a literal `VPBLOCK_<n>` that appears in the plan's
// prose. (The VPSEG segment tokens are hardened the same way.)
const PLACEHOLDER = (i) => `\x01VPBLOCK_${i}\x02`;
const PLACEHOLDER_RE = /\x01VPBLOCK_(\d+)\x02/g;

// Walk the markdown line-by-line, lifting out top-level fenced blocks whose info
// string is a recognized custom type (or an unknown one we must preserve). We
// match the fence marker length so a ``` body containing ``` is handled by ````.
function extractBlocks(md, lean, warnings, reg, lineOffset) {
  const lines = md.split(/\r?\n/);
  const rendered = [];
  const out = [];
  const known = lineOffset != null && lineOffset >= 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceM = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceM) {
      const indent = fenceM[1];
      const fence = fenceM[2];
      const info = fenceM[3].trim();
      const { type, attrs } = parseInfo(info);
      // Find the closing fence (same char, >= length, optional trailing).
      const closeRe = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
      let j = i + 1;
      const bodyLines = [];
      let closed = false;
      while (j < lines.length) {
        if (closeRe.test(lines[j])) { closed = true; break; }
        bodyLines.push(lines[j]);
        j++;
      }
      const body = bodyLines.join("\n");
      if (type && (KNOWN_BLOCKS.has(type) || isUnknownCustom(type, info))) {
        // Map this block's opening/closing fences to 1-based plan.md lines.
        const closeIdx = closed ? j : Math.max(i, lines.length - 1);
        const blockLines = known ? [lineOffset + i + 1, lineOffset + closeIdx + 1] : null;
        const bodyStartLine = known ? lineOffset + i + 2 : null;
        const ctx = { reg, blockLines, bodyStartLine };
        const html = renderBlock(type, attrs, body, lean, warnings, ctx);
        const token = PLACEHOLDER(rendered.length);
        rendered.push(html);
        out.push(token);
        i = closed ? j + 1 : j;
        continue;
      }
      // Not a custom block (e.g. ```js, ```mermaid, ```bash): leave verbatim
      // for marked to render as a normal code block.
      out.push(line);
      for (const b of bodyLines) out.push(b);
      if (closed) out.push(lines[j]);
      i = closed ? j + 1 : j;
      continue;
    }
    out.push(line);
    i++;
  }
  return { md: out.join("\n"), rendered };
}

// Treat any info-string whose first token is a bare identifier we don't know as
// an "unknown custom block" only when it is clearly meant as one (single word,
// no path-like content). Standard language fences (js, ts, bash, json, mermaid,
// etc.) would also be single words, so we DON'T hijack those — only the
// recognized set plus an explicit `unknown`-style marker are lifted. To honor
// format.md ("Unknown block types must render as labeled pre"), we lift any
// info-string that carries key=value attrs OR is not a common language id.
const COMMON_LANGS = new Set([
  "js","javascript","ts","typescript","jsx","tsx","json","yaml","yml","toml",
  "bash","sh","shell","zsh","html","css","scss","md","markdown","python","py",
  "go","rust","rs","java","kotlin","swift","c","cpp","cc","h","hpp","ruby","rb",
  "php","sql","graphql","gql","xml","dockerfile","makefile","ini","diff","text",
  "txt","plaintext","mermaid","tsx","vue","svelte","astro","proto","hcl","nginx",
]);

function isUnknownCustom(type, info) {
  if (KNOWN_BLOCKS.has(type)) return true;
  // If it has attributes (key=value), it's an intended custom block.
  if (/\b[\w-]+\s*=\s*\S/.test(info.slice(type.length))) return true;
  // A single bare word that isn't a known language is treated as unknown custom.
  if (!COMMON_LANGS.has(type.toLowerCase()) && /^[A-Za-z][\w-]*$/.test(type)) return true;
  return false;
}

/* ========================================================================== *
 *  Grouping directives (tabs / collapsible)
 * ========================================================================== */

// Transform the HTML-comment directives into wrapper markup. We operate on the
// markdown string BEFORE marked runs, emitting raw HTML blocks (separated by
// blank lines so marked treats them as HTML and still processes inner markdown).
function transformGrouping(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const tabsStart = /^\s*<!--\s*tabs:start\s*-->\s*$/.exec(line);
    if (tabsStart) {
      const { html, next } = consumeTabs(lines, i);
      out.push("");
      out.push(html);
      out.push("");
      i = next;
      continue;
    }
    const collM = /^\s*<!--\s*collapsible:\s*(.*?)\s*-->\s*$/.exec(line);
    if (collM && !/^end$/i.test(collM[1])) {
      const { html, next } = consumeCollapsible(lines, i, collM[1]);
      out.push("");
      out.push(html);
      out.push("");
      i = next;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// We render inner content by recursively running the full markdown pipeline on
// the captured segment, so nested blocks/markdown work. To avoid double-handling
// the block placeholders, we pass a render function in.
function consumeTabs(lines, start) {
  let i = start + 1;
  const tabs = []; // { label, content: [] }
  let cur = null;
  while (i < lines.length) {
    const endM = /^\s*<!--\s*tabs:end\s*-->\s*$/.exec(lines[i]);
    if (endM) { i++; break; }
    const tabM = /^\s*<!--\s*tab:\s*(.*?)\s*-->\s*$/.exec(lines[i]);
    if (tabM) { cur = { label: tabM[1], content: [] }; tabs.push(cur); i++; continue; }
    if (cur) cur.content.push(lines[i]);
    i++;
  }
  // Build with a marker that the assembler expands. We emit a custom wrapper and
  // inner segments delimited by tokens so the recursive render can fill them.
  let html = '<div data-block="tabs"><div class="tab-bar" role="tablist">';
  tabs.forEach((t, idx) => {
    html += `<button type="button" class="tab-btn" role="tab" aria-selected="${idx === 0 ? "true" : "false"}">${escapeHtml(t.label)}</button>`;
  });
  html += "</div>";
  tabs.forEach((t, idx) => {
    const inner = makeSegment(t.content.join("\n"), -1);
    html += `<div class="tab-panel" role="tabpanel"${idx === 0 ? "" : " hidden"}>${inner}</div>`;
  });
  html += "</div>";
  return { html, next: i };
}

function consumeCollapsible(lines, start, label) {
  let i = start + 1;
  const content = [];
  while (i < lines.length) {
    const endM = /^\s*<!--\s*collapsible:end\s*-->\s*$/.exec(lines[i]);
    if (endM) { i++; break; }
    content.push(lines[i]);
    i++;
  }
  const inner = makeSegment(content.join("\n"), -1);
  const html = `<details data-block="collapsible"><summary>${escapeHtml(label)}</summary><div class="collapsible-body">${inner}</div></details>`;
  return { html, next: i };
}

/* ========================================================================== *
 *  Chapters directive (top-level `<!-- chapter: Title -->`)
 * ========================================================================== */

// Split the body at top-level `<!-- chapter: Title -->` markers into <section>
// chapters, each wrapping a recursive segment (like collapsible) so all nested
// markdown/blocks work. Content before the first marker becomes an "Overview"
// intro chapter. Runs on the RAW body BEFORE block extraction, so each chapter's
// content offset maps to true plan.md lines. Markers inside a tab/collapsible
// body are NOT processed (those bodies are handled by the recursive pass, which
// never calls this). When no marker exists the body is returned untouched, so a
// chapterless plan renders exactly as before.
function transformChapters(body, baseOffset, reg) {
  const lines = body.split(/\r?\n/);
  const markers = [];
  // Track fence state: a `<!-- chapter: … -->` INSIDE a fenced block is example
  // text (e.g. the format doc showing chapter syntax), not a real directive.
  // transformChapters runs before block extraction, so we must skip fences here
  // ourselves (unlike transformGrouping, which sees blocks already lifted out).
  let fenceChar = null, fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const fm = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (fm) {
      const ch = fm[1][0], len = fm[1].length;
      if (!fenceChar) { fenceChar = ch; fenceLen = len; }
      else if (ch === fenceChar && len >= fenceLen) { fenceChar = null; fenceLen = 0; }
      continue;
    }
    if (fenceChar) continue;
    const m = /^\s*<!--\s*chapter:\s*(.+?)\s*-->\s*$/.exec(lines[i]);
    if (m && !/^end$/i.test(m[1])) markers.push({ index: i, title: m[1].trim() });
  }
  if (!markers.length) return { html: body, hasChapters: false, nav: "" };

  const segments = [];
  const firstIdx = markers[0].index;
  const introHasContent = lines.slice(0, firstIdx).some((l) => l.trim() !== "");
  if (introHasContent) {
    segments.push({ title: "Overview", markerIdx: null, contentStartIdx: 0, endIdx: firstIdx - 1 });
  }
  for (let k = 0; k < markers.length; k++) {
    const start = markers[k].index;
    const end = (k + 1 < markers.length ? markers[k + 1].index : lines.length) - 1;
    segments.push({ title: markers[k].title, markerIdx: start, contentStartIdx: start + 1, endIdx: end });
  }

  // Trim trailing blank lines from each chapter's range so a range ends on the
  // last real line of the chapter (robust to a file's trailing newline).
  for (const seg of segments) {
    const floor = seg.markerIdx != null ? seg.markerIdx : seg.contentStartIdx;
    while (seg.endIdx > floor && lines[seg.endIdx].trim() === "") seg.endIdx--;
  }

  const out = [];
  const navLinks = [];
  for (const seg of segments) {
    const content = lines.slice(seg.contentStartIdx, seg.endIdx + 1).join("\n");
    const contentOffset = baseOffset + seg.contentStartIdx; // 0-based source index
    const rangeStart = baseOffset + (seg.markerIdx != null ? seg.markerIdx : seg.contentStartIdx) + 1;
    const rangeEnd = baseOffset + seg.endIdx + 1;
    const anchor = registerAnchor(reg, "chapter", seg.title, seg.title, [rangeStart, rangeEnd]);
    navLinks.push({ anchor, title: seg.title });
    const inner = makeSegment(content, contentOffset);
    out.push("");
    out.push(
      `<section class="pf-chapter" data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">` +
      `<h2 class="pf-chapter-heading">${escapeHtml(seg.title)}</h2>${inner}</section>`,
    );
    out.push("");
  }

  let nav = '<nav class="pf-sidenav" aria-label="Chapters"><details class="pf-sidenav-box" open>' +
    '<summary class="pf-sidenav-summary">Chapters</summary><ul class="pf-sidenav-list">';
  for (const l of navLinks) {
    nav += `<li><a class="pf-sidenav-link" href="#${esc(l.anchor)}" data-chapter-link="${esc(l.anchor)}">${escapeHtml(l.title)}</a></li>`;
  }
  nav += "</ul></details></nav>";

  return { html: out.join("\n"), hasChapters: true, nav };
}

// Tokens marking base64 segments of markdown that must be rendered recursively.
const SEGMENT_OPEN = "\x01VPSEG\x01";
const SEGMENT_CLOSE = "\x02VPSEG\x02";
const SEGMENT_RE = /\x01VPSEG\x01(-?\d+):([A-Za-z0-9+/=]*)\x02VPSEG\x02/g;
// A recursive-segment token: sentinels wrap "<lineOffset>:<base64>". The offset
// is the 0-based index of the segment's first line in the ORIGINAL plan.md
// (negative = unknown, so nested block line ranges fall back to null).
function makeSegment(content, offset) {
  return SEGMENT_OPEN + (offset | 0) + ":" + Buffer.from(content, "utf8").toString("base64") + SEGMENT_CLOSE;
}

/* ========================================================================== *
 *  Markdown rendering
 * ========================================================================== */

function configureMarked() {
  marked.setOptions({ gfm: true, breaks: false });
}

// Offline purity: the output is a self-contained file:// document that must not
// load (or be able to load) any external resource at view time. Prose authored
// in standard Markdown may legitimately contain links/images to remote URLs;
// `marked` renders those as <a href="https://…"> / <img src="https://…">.
// We keep the link *visible* (text + a title showing the original URL) but make
// it inert so nothing is ever fetched and no external-URL token survives in an
// attribute. Remote <img> become a labeled placeholder rather than a fetch.
function neutralizeRemoteRefs(html) {
  const REMOTE = /^(?:https?:)?\/\//i;
  // Anchors: drop a remote href, surface it as a (non-fetching) data attribute.
  html = html.replace(
    /<a\b([^>]*?)\shref\s*=\s*(["'])([^"']*)\2([^>]*)>/gi,
    (m, pre, q, url, post) => {
      if (!REMOTE.test(url.trim())) return m;
      // Strip the protocol/host so no external-URL token remains; keep the
      // human-readable target for context, escaped, in a non-fetched attr.
      const shown = url.replace(/^(?:https?:)?\/\//i, "");
      return `<a${pre}${post} data-external-href="${esc(shown)}" title="external link (disabled offline): ${esc(shown)}">`;
    },
  );
  // Images with a remote src: replace with an inert labeled placeholder span.
  html = html.replace(
    /<img\b([^>]*?)\ssrc\s*=\s*(["'])([^"']*)\2([^>]*)>/gi,
    (m, pre, q, url) => {
      if (!REMOTE.test(url.trim())) return m;
      const shown = url.replace(/^(?:https?:)?\/\//i, "");
      const altM = /\balt\s*=\s*(["'])([^"']*)\1/i.exec(pre + " " + m);
      const label = altM ? altM[2] : shown;
      return `<span class="ext-img-placeholder" data-external-src="${esc(shown)}">${esc(label)}</span>`;
    },
  );
  return html;
}

// Add content-derived anchors (data-pf-anchor + matching id) to prose headings
// and paragraphs in a marked() segment. Runs while custom-block placeholders and
// recursive-segment tokens are still sentinels, so a <p>/<h> that holds only such
// a token is skipped (it becomes a block/segment on expansion). Marked emits
// attribute-less <hN>; the chapter title heading carries a class, so it is
// excluded from re-tagging.
function tagProseAnchors(html, reg) {
  const holdsToken = (s) => /[\x01\x02]|VPSEG/.test(s);
  html = html.replace(/<h([1-6])((?:\s[^>]*?)?)>([\s\S]*?)<\/h\1>/g, (m, level, attrs, inner) => {
    if (/pf-chapter-heading|data-pf-anchor|\sid=/.test(attrs)) return m;
    if (holdsToken(inner)) return m;
    const text = decodeEntitiesLite(stripTags(inner)).replace(/\s+/g, " ").trim();
    if (!text) return m;
    const anchor = registerAnchor(reg, "h", text, text, findHeadingLines(reg, text));
    return `<h${level}${attrs} data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">${inner}</h${level}>`;
  });
  html = html.replace(/<p>([\s\S]*?)<\/p>/g, (m, inner) => {
    if (holdsToken(inner)) return m;
    const text = decodeEntitiesLite(stripTags(inner)).replace(/\s+/g, " ").trim();
    if (!text) return m;
    const slugSource = text.split(" ").slice(0, 6).join(" ");
    const label = text.length > 80 ? text.slice(0, 79) + "…" : text;
    const anchor = registerAnchor(reg, "p", slugSource, label, null);
    return `<p data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">${inner}</p>`;
  });
  // Prose list items (both <ul> and <ol>, nested included). Marked emits bare
  // <li> for prose; custom blocks (steps/filetree/…) are parked as placeholders
  // at this stage, so their internal <li class="step"|"tree-row"…> never appear
  // here — only genuine prose items match, each getting its own kind `li` anchor
  // (a steps block's items keep their kind `step`, never `li`). The slug is the
  // item's OWN leading text: we capture up to the first nested-list / sibling /
  // close boundary so a parent's slug isn't polluted by its children, then trim
  // to ~6 words. Lines are null (same contract as `p` — no cheap source-map
  // lookup exists for list items, and building one speculatively isn't worth it).
  html = html.replace(/<li>([\s\S]*?)(?=<ul|<ol|<li|<\/li)/g, (m, inner, offset, str) => {
    // GFM task-list items ("- [ ] " / "- [x] ") are marked's own extension: its
    // Parser prepends a checkbox <input disabled type="checkbox"> as the very
    // first thing inside the <li> (vendor/marked.esm.js, Parser#parse "list"
    // case + Renderer#checkbox) — loose lists may wrap it in a leading <p>.
    // Detect that shape so a task item gets its own `task:` anchor kind (kept
    // distinct from a plain `li:` prose bullet) and its checkbox is enabled —
    // this reuses the exact same registerAnchor plumbing (grammar, collision
    // numbering, doc order) notes/steps/questions already use, rather than
    // inventing a parallel id scheme for checklists.
    const taskMatch = /^\s*(?:<p>\s*)?<input\b[^>]*\btype="checkbox"[^>]*>/i.exec(inner);
    let taggedInner = inner;
    if (taskMatch) {
      const enabled = taskMatch[0].replace(/\s*disabled=""/i, "");
      taggedInner = enabled + inner.slice(taskMatch[0].length);
    }
    let text = liLeadingText(taggedInner);
    if (!text) {
      // Own leading text is empty (e.g. an item whose body is only a nested list
      // or a parked block); widen to the fuller textContent so it still slugs.
      text = liLeadingText(str.slice(offset, offset + 400));
    }
    if (!text) return m; // truly empty item — nothing to anchor on
    const slugSource = text.split(" ").slice(0, 6).join(" ");
    if (taskMatch) {
      // Fuller label than a plain `li` (whose label is just the 6-word slug) —
      // the checklist export wants readable item text, not a truncated slug;
      // mirrors the `p` prose convention (short id slug, longer display label).
      const label = text.length > 80 ? text.slice(0, 79) + "…" : text;
      const anchor = registerAnchor(reg, "task", slugSource, label, null);
      return `<li data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">${taggedInner}`;
    }
    const anchor = registerAnchor(reg, "li", slugSource, slugSource, null);
    return `<li data-pf-anchor="${esc(anchor)}" id="${esc(anchor)}">${taggedInner}`;
  });
  return html;
}

// Leading text of a prose list item: drop inline tags and any parked
// block/segment sentinels (so a list item wrapping a custom block doesn't slug
// on "VPBLOCK_0"), decode the entities we emit, and collapse whitespace.
function liLeadingText(fragment) {
  const stripped = String(fragment)
    .replace(/\x01VPBLOCK_\d+\x02/g, " ")
    .replace(/VPSEG-?\d+:[A-Za-z0-9+/=]*VPSEG/g, " ");
  return decodeEntitiesLite(stripTags(stripped))
    .replace(/[\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Full markdown->html for a segment of source (used at top level and recursively
// inside tab/collapsible/chapter segments). `rendered` is the shared block array;
// `reg` is the shared anchor registry; `lineOffset` is the 0-based index of this
// segment's first line in the original plan.md (negative = unknown).
function renderMarkdownSegment(source, lean, warnings, rendered, reg, lineOffset) {
  // 1. Extract custom fenced blocks into placeholders.
  const extracted = extractBlocks(source, lean, warnings, reg, lineOffset);
  // shift placeholder indices: extractBlocks pushes into its own array, but we
  // need a single shared array. Re-map.
  let md = extracted.md;
  const base = rendered.length;
  if (extracted.rendered.length) {
    md = md.replace(PLACEHOLDER_RE, (_, n) => PLACEHOLDER(base + parseInt(n, 10)));
    for (const h of extracted.rendered) rendered.push(h);
  }
  // 2. Grouping directives -> wrapper markup with recursive segment tokens.
  md = transformGrouping(md);
  // 3. marked on the remaining markdown. At this point custom block HTML and
  //    trusted wireframe bodies are still parked in placeholders, so the only
  //    refs present are prose links/images authored as Markdown — neutralize any
  //    remote ones to keep the document offline-pure.
  let html = neutralizeRemoteRefs(marked.parse(md));
  // 3b. Tag prose headings (h1–h6) and paragraphs with content-derived anchors.
  //     Block placeholders and recursive-segment tokens are still sentinels here,
  //     so this can only ever touch genuine prose — never inside a rendered block.
  html = tagProseAnchors(html, reg);
  // NOTE: marked rewrites the literal spaces that delimit our placeholder
  // tokens into NUL bytes (\u0000) internally, so the "whitespace" around a
  // lone token may be a NUL rather than a space. The patterns below allow both.
  const PAD = "[\\s\\u0000]*";
  // 4. Expand recursive segments (unwrap a lone-in-paragraph token first so we
  //    don't emit block-level wrappers inside a <p>).
  html = html
    .replace(new RegExp(`<p>${PAD}VPSEG(-?\\d+):([A-Za-z0-9+/=]*)VPSEG${PAD}</p>`, "g"), (_, off, b64) =>
      renderMarkdownSegment(Buffer.from(b64, "base64").toString("utf8"), lean, warnings, rendered, reg, parseInt(off, 10)))
    .replace(SEGMENT_RE, (_, off, b64) =>
      renderMarkdownSegment(Buffer.from(b64, "base64").toString("utf8"), lean, warnings, rendered, reg, parseInt(off, 10)));
  // 5. Re-insert block HTML at placeholders. Unwrap a placeholder that marked
  //    parked alone inside a <p> so block elements aren't nested in <p>.
  html = html
    .replace(new RegExp(`<p>${PAD}\\x01VPBLOCK_(\\d+)\\x02${PAD}</p>`, "g"), (_, n) => rendered[parseInt(n, 10)] ?? "")
    .replace(new RegExp(`${PAD}\\x01VPBLOCK_(\\d+)\\x02${PAD}`, "g"), (_, n) => rendered[parseInt(n, 10)] ?? "");
  return html;
}

/* ========================================================================== *
 *  Assembly
 * ========================================================================== */

let _templateCache = null;
function loadTemplate() {
  if (_templateCache) return _templateCache;
  _templateCache = {
    template: readFileSync(join(HERE, "template.html"), "utf8"),
    styles: readFileSync(join(HERE, "styles.css"), "utf8"),
    interactivity: readFileSync(join(HERE, "interactivity.js"), "utf8"),
    // annotate.css / annotate.js are the click-to-annotate layer (owned by a
    // companion agent). They may be near-empty stubs; inlined the same way so the
    // output stays one self-contained file.
    annotateCss: readFileSync(join(HERE, "annotate.css"), "utf8"),
    annotateJs: readFileSync(join(HERE, "annotate.js"), "utf8"),
  };
  return _templateCache;
}

function loadMermaid() {
  return readFileSync(join(HERE, "vendor", "mermaid.min.js"), "utf8");
}

// The hand-drawn diagram font (Virgil, OFL-1.1) embedded as a base64 data URI so
// the output stays a single self-contained, offline file — no web-font fetch.
// Injected only when a hand-drawn diagram is present (and never in --lean output).
let _virgilCache = null;
function loadVirgilFontFace() {
  if (_virgilCache === null) {
    const b64 = readFileSync(join(HERE, "vendor", "virgil.woff2")).toString("base64");
    _virgilCache =
      `<style>@font-face{font-family:"Virgil";font-style:normal;font-weight:400;` +
      `font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2");}</style>`;
  }
  return _virgilCache;
}

// Two displacement filters at different frequencies give a hand-drawn wobble:
// `wf-rough` for the screen frame / large elements, `wf-rough-fine` for small
// controls so their short edges still look sketched rather than melted.
const SKETCHY_FILTER = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><filter id="wf-rough" x="-6%" y="-6%" width="112%" height="112%"><feTurbulence type="fractalNoise" baseFrequency="0.016 0.014" numOctaves="3" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G"/></filter><filter id="wf-rough-fine" x="-8%" y="-8%" width="116%" height="116%"><feTurbulence type="fractalNoise" baseFrequency="0.032 0.028" numOctaves="2" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.7" xChannelSelector="R" yChannelSelector="G"/></filter></defs></svg>`;

export function renderPlan(markdownSource, { lean = false, sourcePath = null } = {}) {
  configureMarked();
  const source = String(markdownSource ?? "");
  const { frontmatter, body, bodyOffset } = parseFrontmatter(source);
  const title = frontmatter.title || "Untitled plan";
  const slug = slugify(title);
  const warnings = [];

  // Shared anchor registry + doc identity (the feedback plumbing).
  const reg = createRegistry(source, sourcePath, title);
  const docId = computeDocId(source);

  // Chapters are a top-level directive resolved BEFORE block extraction, so each
  // chapter's content maps to true plan.md lines. Chapter anchors register here.
  const chapters = transformChapters(body, bodyOffset, reg);

  const rendered = [];
  const bodyHtml = renderMarkdownSegment(chapters.html, lean, warnings, rendered, reg, bodyOffset);

  const plumbing = anchorMapScript(reg, docId) + "\n" + embeddedSourceScript(source);

  const usesSketchy = /class="wf-screen[^"]*\bis-sketchy/.test(bodyHtml);
  // NOTE: the `<pre class="mermaid">` now carries a `data-look="…"` attribute, so
  // match the opening tag WITHOUT requiring the immediate `>` (a `/…">/` regex
  // here would silently stop inlining the bundle).
  const usesMermaid = !lean && /<pre class="mermaid"[\s>]/.test(bodyHtml);
  const usesHandDrawn = usesMermaid && /<pre class="mermaid" data-look="handDrawn"/.test(bodyHtml);

  const { template, styles, interactivity, annotateCss, annotateJs } = loadTemplate();

  // Header pieces
  const statusRaw = (frontmatter.status || "").toLowerCase();
  const validStatus = ["draft", "proposed", "approved"].includes(statusRaw) ? statusRaw : "";
  const statusHtml = validStatus
    ? `<span class="status-pill" data-status="${validStatus}">${escapeHtml(validStatus)}</span>`
    : (frontmatter.status ? `<span class="status-pill" data-status="draft">${escapeHtml(frontmatter.status)}</span>` : "");
  const objectiveHtml = frontmatter.objective
    ? `<p class="plan-objective">${escapeHtml(frontmatter.objective)}</p>`
    : "";

  let mermaidScript = "";
  if (usesMermaid) {
    mermaidScript = `<script>\n${loadMermaid()}\n</script>`;
  }

  // Embed the hand-drawn font only when a hand-drawn diagram actually needs it.
  const fontFace = usesHandDrawn ? loadVirgilFontFace() : "";

  const sketchyDefs = usesSketchy ? SKETCHY_FILTER : "";

  // IMPORTANT: every replacement value is passed as a *function* returning the
  // literal text. String replacements interpret `$$`, `$&`, `` $` ``, `$'` and
  // `$1`..`$9` in the replacement, and our injected content (notably the inlined
  // mermaid bundle, which contains `` $` `` and `$&` etc.) would otherwise be
  // mangled — `` $` `` splices in "everything before the match", duplicating the
  // whole document body. Function replacements treat the value as a literal.
  const bodyValue = sketchyDefs + "\n" + bodyHtml;
  const bodyAttr = chapters.hasChapters ? ' data-has-chapters="true"' : "";
  let html = template
    .replace("<!-- TITLE -->", () => escapeHtml(title))
    .replace("<!-- BODYATTR -->", () => bodyAttr)
    .replace("<!-- STATUS -->", () => statusHtml)
    .replaceAll("<!-- HEADING -->", () => escapeHtml(title))
    .replace("<!-- OBJECTIVE -->", () => objectiveHtml)
    .replace("<!-- SIDENAV -->", () => chapters.nav)
    .replace("<!-- BODY -->", () => bodyValue)
    .replace("<!-- FONT -->", () => fontFace)
    .replace("<!-- PLUMBING -->", () => plumbing)
    .replace("<!-- MERMAID -->", () => mermaidScript)
    .replace("/* INLINE:styles.css */", () => styles)
    .replace("/* INLINE:annotate.css */", () => annotateCss)
    .replace("/* INLINE:interactivity.js */", () => interactivity)
    .replace("/* INLINE:annotate.js */", () => annotateJs);

  return { html, title, slug, warnings, docId };
}

/* ========================================================================== *
 *  Output location
 * ========================================================================== */

function isWritable(dir) {
  try { accessSync(dir, constants.W_OK); return true; } catch { return false; }
}

function defaultOutPath(slug) {
  const cwd = process.cwd();
  if (isWritable(cwd)) {
    return join(cwd, ".visual-plans", slug, "index.html");
  }
  return join("/tmp", "visual-plans", slug, "index.html");
}

/* ========================================================================== *
 *  CLI
 * ========================================================================== */

function parseArgs(argv) {
  const args = { input: null, out: null, lean: false, open: false, noOpen: false, github: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lean") args.lean = true;
    else if (a === "--open") args.open = true;
    else if (a === "--no-open") args.noOpen = true;
    else if (a === "--github") args.github = true;
    else if (a === "--out") { args.out = argv[++i]; }
    else if (a.startsWith("--out=")) { args.out = a.slice("--out=".length); }
    else if (a === "-h" || a === "--help") { args.help = true; }
    else if (!a.startsWith("-") && !args.input) { args.input = a; }
    else { args.unknown = a; }
  }
  return args;
}

const USAGE = `usage: node render.mjs <plan.md> [--out <path>] [--lean] [--open] [--no-open] [--github]

  <plan.md>     path to a plan written in the visual-plan format
  --out <path>  output HTML path (default: ./.visual-plans/<slug>/index.html)
  --lean        omit the inlined mermaid bundle (diagrams shown as code)
  --open        open the produced file in the browser
  --no-open     do not open (default)
  --github      also write github.md (GitHub-flavored Markdown for PR comments)
                next to the output HTML`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (!args.input) {
    console.error("error: no input plan.md given\n");
    console.error(USAGE);
    process.exit(2);
  }

  const inputPath = resolve(args.input);
  let source;
  try {
    source = readFileSync(inputPath, "utf8");
  } catch (e) {
    console.error(`error: cannot read ${args.input}: ${e.message}`);
    process.exit(1);
  }

  let result;
  try {
    result = renderPlan(source, { lean: args.lean, sourcePath: inputPath });
  } catch (e) {
    console.error(`error: failed to render plan: ${e.stack || e.message}`);
    process.exit(1);
  }

  const outPath = args.out ? resolve(args.out) : defaultOutPath(result.slug);
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.html, "utf8");
  } catch (e) {
    console.error(`error: cannot write ${outPath}: ${e.message}`);
    process.exit(1);
  }

  for (const w of result.warnings) console.error(`warning: ${w}`);
  console.log(`wrote ${outPath}`);
  console.log(`title: ${result.title}`);

  if (args.github) {
    try {
      const { buildGithubMarkdown } = await import("./github-md.mjs");
      const ghPath = join(dirname(outPath), "github.md");
      writeFileSync(ghPath, buildGithubMarkdown(source), "utf8");
      console.log(`github: ${ghPath}`);
    } catch (e) {
      console.error(`warning: --github emit failed: ${e.message}`);
    }
  }

  if (args.open && !args.noOpen) {
    try {
      const { openFile } = await import("./open.mjs");
      const res = await openFile(outPath);
      // Always surface a clickable path — even when auto-open works, and
      // especially when it doesn't (e.g. WSL interop disabled). The Windows/UNC
      // path opens straight from the Windows side; hand it to the user.
      if (res.targets) {
        if (res.targets.winPath) console.log(`windows: ${res.targets.winPath}`);
        console.log(`url:     ${res.targets.fileUrl}`);
      }
      if (res.ok) console.log(`opened via ${res.via}`);
      else console.error("note: could not auto-open a browser — click the path above");
    } catch (e) {
      console.error(`warning: open failed: ${e.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
