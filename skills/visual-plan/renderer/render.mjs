// render.mjs — visual-plan renderer.
//
// Turns a `plan.md` (see references/format.md) into a single self-contained,
// offline, interactive HTML document. Zero npm install: the only dependency is
// the vendored `marked`. Mermaid is NOT used in Node; it is inlined into the
// output and runs in the browser.
//
// Programmatic API:
//   renderPlan(markdownSource, { lean = false }) => { html, title, slug, warnings }
//
// CLI:
//   node render.mjs <plan.md> [--out <path>] [--lean] [--open] [--no-open]

import { readFileSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  }
  return { frontmatter: fm, body };
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
 *  Block info-string parsing
 * ========================================================================== */

const KNOWN_BLOCKS = new Set([
  "steps", "filetree", "diff", "code", "diagram", "wireframe", "questions",
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

function renderSteps(body) {
  const lines = body.split(/\r?\n/);
  const steps = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const titleM = /^#\s+(.*)$/.exec(line);
    if (titleM) {
      cur = { title: titleM[1].trim(), files: [], why: [] };
      steps.push(cur);
      continue;
    }
    if (!cur) {
      // body before any step title — start an untitled step so nothing is lost
      cur = { title: "", files: [], why: [] };
      steps.push(cur);
    }
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
    out += '<li class="step">';
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

function renderFiletree(body) {
  const lines = body.split(/\r?\n/);
  let out = '<div data-block="filetree"><ul>';
  for (const raw of lines) {
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
    out += `<li class="tree-row" data-change="${change}" data-depth="${depth}" data-flag="${esc(displayFlag)}"`;
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
  const rows = []; // { type:'hunk'|'add'|'del'|'ctx'|'note', text, oldNo, newNo }
  let oldNo = 0, newNo = 0;
  for (const raw of lines) {
    const noteM = /^@note:\s?(.*)$/.exec(raw);
    if (noteM) { rows.push({ type: "note", text: noteM[1] }); continue; }
    const hunkM = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/.exec(raw);
    if (hunkM) {
      oldNo = parseInt(hunkM[1], 10);
      newNo = parseInt(hunkM[2], 10);
      rows.push({ type: "hunk", text: raw });
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
      out += `<tr class="diff-line" data-line="hunk"><td colspan="3">${esc(r.text)}</td></tr>`;
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
      pushPair({ type: r.type, text: r.text }, { type: r.type, text: r.text });
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
        p += `<tr class="diff-line" data-line="hunk"><td colspan="2">${esc(row.text)}</td></tr>`;
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

function renderDiff(body, attrs) {
  const mode = attrs.mode === "split" ? "split" : "unified";
  const rows = parseDiff(body);
  let out = `<figure data-block="diff" data-mode="${mode}">`;
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

function renderCode(body, attrs) {
  const lang = attrs.lang || "";
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

  let out = `<figure data-block="code" data-lang="${esc(lang)}">`;
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

function renderDiagram(body, attrs, lean) {
  let out = '<figure data-block="diagram">';
  if (attrs.title) out += `<figcaption>${esc(attrs.title)}</figcaption>`;
  if (lean) {
    out += `<pre class="diagram-lean"><code>${esc(body.replace(/\s+$/, ""))}</code></pre>`;
  } else {
    // Raw mermaid source; escaped so the browser-side mermaid receives text,
    // not parsed HTML. Mermaid reads textContent, so entities are decoded.
    out += `<pre class="mermaid">${esc(body.replace(/\s+$/, ""))}</pre>`;
  }
  out += "</figure>";
  return out;
}

const SURFACES = new Set(["page", "panel", "popover", "sheet", "toolbar"]);

function renderWireframe(body, attrs) {
  const surface = SURFACES.has(attrs.surface) ? attrs.surface : "page";
  const sketchy = attrs.style === "sketchy";
  let out = `<figure data-block="wireframe" data-surface="${surface}">`;
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

function renderQuestions(body) {
  const lines = body.split(/\r?\n/);
  const qs = [];
  let cur = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const qM = /^#\s+(.*)$/.exec(raw.trim());
    if (qM) { cur = { text: qM[1].trim(), def: "" }; qs.push(cur); continue; }
    const dM = /^default:\s?(.*)$/i.exec(raw.trim());
    if (dM && cur) { cur.def = dM[1].trim(); continue; }
    if (cur) cur.text += " " + raw.trim();
  }
  let out = '<div data-block="questions">';
  for (const q of qs) {
    out += '<div class="question">';
    out += `<p class="q-text">${esc(q.text)}</p>`;
    if (q.def) out += `<p class="q-default">${esc(q.def)}</p>`;
    out += "</div>";
  }
  out += "</div>";
  return out;
}

function renderUnknown(type, body) {
  return `<pre data-block="unknown" data-type="${esc(type)}">${esc(body.replace(/\s+$/, ""))}</pre>`;
}

function renderBlock(type, attrs, body, lean, warnings) {
  switch (type) {
    case "steps": return renderSteps(body);
    case "filetree": return renderFiletree(body);
    case "diff": return renderDiff(body, attrs);
    case "code": return renderCode(body, attrs);
    case "diagram": return renderDiagram(body, attrs, lean);
    case "wireframe": return renderWireframe(body, attrs);
    case "questions": return renderQuestions(body);
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
function extractBlocks(md, lean, warnings) {
  const lines = md.split(/\r?\n/);
  const rendered = [];
  const out = [];
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
        const html = renderBlock(type, attrs, body, lean, warnings);
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
    const inner = SEGMENT_OPEN + Buffer.from(t.content.join("\n")).toString("base64") + SEGMENT_CLOSE;
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
  const inner = SEGMENT_OPEN + Buffer.from(content.join("\n")).toString("base64") + SEGMENT_CLOSE;
  const html = `<details data-block="collapsible"><summary>${escapeHtml(label)}</summary><div class="collapsible-body">${inner}</div></details>`;
  return { html, next: i };
}

// Tokens marking base64 segments of markdown that must be rendered recursively.
const SEGMENT_OPEN = "VPSEG";
const SEGMENT_CLOSE = "VPSEG";
const SEGMENT_RE = /VPSEG([A-Za-z0-9+/=]*)VPSEG/g;

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

// Full markdown->html for a segment of source (used at top level and recursively
// inside tab/collapsible segments). `rendered` is the shared block array.
function renderMarkdownSegment(source, lean, warnings, rendered) {
  // 1. Extract custom fenced blocks into placeholders.
  const extracted = extractBlocks(source, lean, warnings);
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
  // NOTE: marked rewrites the literal spaces that delimit our placeholder
  // tokens into NUL bytes ( ) internally, so the "whitespace" around a
  // lone token may be a NUL rather than a space. The patterns below allow both.
  const PAD = "[\\s\\u0000]*";
  // 4. Expand recursive segments (unwrap a lone-in-paragraph token first so we
  //    don't emit block-level wrappers inside a <p>).
  html = html
    .replace(new RegExp(`<p>${PAD}VPSEG([A-Za-z0-9+/=]*)VPSEG${PAD}</p>`, "g"), (_, b64) =>
      renderMarkdownSegment(Buffer.from(b64, "base64").toString("utf8"), lean, warnings, rendered))
    .replace(SEGMENT_RE, (_, b64) =>
      renderMarkdownSegment(Buffer.from(b64, "base64").toString("utf8"), lean, warnings, rendered));
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
  };
  return _templateCache;
}

function loadMermaid() {
  return readFileSync(join(HERE, "vendor", "mermaid.min.js"), "utf8");
}

// Two displacement filters at different frequencies give a hand-drawn wobble:
// `wf-rough` for the screen frame / large elements, `wf-rough-fine` for small
// controls so their short edges still look sketched rather than melted.
const SKETCHY_FILTER = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><filter id="wf-rough" x="-6%" y="-6%" width="112%" height="112%"><feTurbulence type="fractalNoise" baseFrequency="0.016 0.014" numOctaves="3" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.6" xChannelSelector="R" yChannelSelector="G"/></filter><filter id="wf-rough-fine" x="-8%" y="-8%" width="116%" height="116%"><feTurbulence type="fractalNoise" baseFrequency="0.032 0.028" numOctaves="2" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.7" xChannelSelector="R" yChannelSelector="G"/></filter></defs></svg>`;

export function renderPlan(markdownSource, { lean = false } = {}) {
  configureMarked();
  const { frontmatter, body } = parseFrontmatter(String(markdownSource ?? ""));
  const title = frontmatter.title || "Untitled plan";
  const slug = slugify(title);
  const warnings = [];

  const rendered = [];
  const bodyHtml = renderMarkdownSegment(body, lean, warnings, rendered);

  const usesSketchy = /class="wf-screen[^"]*\bis-sketchy/.test(bodyHtml);
  const usesMermaid = !lean && /<pre class="mermaid">/.test(bodyHtml);

  const { template, styles, interactivity } = loadTemplate();

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

  const sketchyDefs = usesSketchy ? SKETCHY_FILTER : "";

  // IMPORTANT: every replacement value is passed as a *function* returning the
  // literal text. String replacements interpret `$$`, `$&`, `` $` ``, `$'` and
  // `$1`..`$9` in the replacement, and our injected content (notably the inlined
  // mermaid bundle, which contains `` $` `` and `$&` etc.) would otherwise be
  // mangled — `` $` `` splices in "everything before the match", duplicating the
  // whole document body. Function replacements treat the value as a literal.
  const bodyValue = sketchyDefs + "\n" + bodyHtml;
  let html = template
    .replace("<!-- TITLE -->", () => escapeHtml(title))
    .replace("<!-- STATUS -->", () => statusHtml)
    .replaceAll("<!-- HEADING -->", () => escapeHtml(title))
    .replace("<!-- OBJECTIVE -->", () => objectiveHtml)
    .replace("<!-- BODY -->", () => bodyValue)
    .replace("<!-- MERMAID -->", () => mermaidScript)
    .replace("/* INLINE:styles.css */", () => styles)
    .replace("/* INLINE:interactivity.js */", () => interactivity);

  return { html, title, slug, warnings };
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
  const args = { input: null, out: null, lean: false, open: false, noOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--lean") args.lean = true;
    else if (a === "--open") args.open = true;
    else if (a === "--no-open") args.noOpen = true;
    else if (a === "--out") { args.out = argv[++i]; }
    else if (a.startsWith("--out=")) { args.out = a.slice("--out=".length); }
    else if (a === "-h" || a === "--help") { args.help = true; }
    else if (!a.startsWith("-") && !args.input) { args.input = a; }
    else { args.unknown = a; }
  }
  return args;
}

const USAGE = `usage: node render.mjs <plan.md> [--out <path>] [--lean] [--open] [--no-open]

  <plan.md>     path to a plan written in the visual-plan format
  --out <path>  output HTML path (default: ./.visual-plans/<slug>/index.html)
  --lean        omit the inlined mermaid bundle (diagrams shown as code)
  --open        open the produced file in the browser
  --no-open     do not open (default)`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (!args.input) {
    console.error("error: no input plan.md given\n");
    console.error(USAGE);
    process.exit(2);
  }

  let source;
  try {
    source = readFileSync(resolve(args.input), "utf8");
  } catch (e) {
    console.error(`error: cannot read ${args.input}: ${e.message}`);
    process.exit(1);
  }

  let result;
  try {
    result = renderPlan(source, { lean: args.lean });
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

  if (args.open && !args.noOpen) {
    try {
      const { openFile } = await import("./open.mjs");
      const res = await openFile(outPath);
      if (res.ok) console.log(`opened via ${res.via}`);
      else console.error("warning: could not open the file (no working opener)");
    } catch (e) {
      console.error(`warning: open failed: ${e.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
