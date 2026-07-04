#!/usr/bin/env node
// github-md.mjs — degraded-but-inline GitHub-flavored Markdown rendition of a
// plan.md, meant for pasting straight into a PR comment/description.
//
// GitHub renders ```mermaid fences natively in PR comments/issues, plus
// <details>/<summary> and GitHub alert blockquotes (> [!NOTE] / [!IMPORTANT] /
// [!WARNING] / [!CAUTION]) — but it does NOT understand our custom fenced
// blocks (```steps, ```diagram, ```wireframe, ...) or raw wireframe HTML. This
// module transforms a plan.md source string into a plain .md string using only
// constructs GitHub already renders. Anchors, notes, tabs-as-UI and the
// interactive question forms are lost — this is intentionally the degraded
// path; the full experience still lives at the rendered HTML's URL.
//
// Deliberately standalone: it re-implements its own small fence-aware line
// scanner (the same fence-length-aware approach render.mjs's extractBlocks
// uses) rather than importing render.mjs, so the two renderers can evolve
// independently.
//
// Programmatic API:
//   buildGithubMarkdown(source) -> string   (pure)
//
// CLI:
//   node github-md.mjs <plan.md> [--out <path>]

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/* ========================================================================== *
 *  Frontmatter
 * ========================================================================== */

function parseFrontmatter(src) {
  const fm = { title: "", objective: "", status: "" };
  let body = src;
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (const line of lines) {
      const km = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (!km) continue;
      const key = km[1].toLowerCase();
      let val = km[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key === "title" || key === "objective" || key === "status") fm[key] = val;
    }
    body = src.slice(m[0].length);
  }
  return { frontmatter: fm, body };
}

function buildFrontmatterLines(fm) {
  const out = [];
  if (fm.title) out.push(`# ${fm.title}`);
  if (fm.objective) {
    if (out.length) out.push("");
    out.push(`> ${fm.objective}`);
  }
  if (fm.status) {
    if (out.length) out.push("");
    out.push(`**status:** ${fm.status}`);
  }
  return out;
}

/* ========================================================================== *
 *  Block info-string parsing (mirrors render.mjs's parseInfo; standalone copy)
 * ========================================================================== */

function parseInfo(info) {
  const trimmed = info.trim();
  if (!trimmed) return { type: "", attrs: {} };
  const type = trimmed.split(/\s+/, 1)[0];
  const rest = trimmed.slice(type.length);
  const attrs = {};
  const re = /([\w-]+)=("([^"]*)"|'([^']*)'|([^\s=]*))/g;
  let mm;
  while ((mm = re.exec(rest))) {
    attrs[mm[1]] = mm[3] !== undefined ? mm[3] : mm[4] !== undefined ? mm[4] : mm[5];
  }
  return { type, attrs };
}

const KNOWN_BLOCKS = new Set([
  "steps", "filetree", "diff", "code", "diagram", "wireframe", "questions", "callout",
  "data-model", "api-endpoint",
]);

// Same boundary render.mjs draws between "an intentional custom block" and "a
// standard language fence" — duplicated here (not imported) so this module
// stays standalone.
const COMMON_LANGS = new Set([
  "js", "javascript", "ts", "typescript", "jsx", "tsx", "json", "yaml", "yml", "toml",
  "bash", "sh", "shell", "zsh", "html", "css", "scss", "md", "markdown", "python", "py",
  "go", "rust", "rs", "java", "kotlin", "swift", "c", "cpp", "cc", "h", "hpp", "ruby", "rb",
  "php", "sql", "graphql", "gql", "xml", "dockerfile", "makefile", "ini", "diff", "text",
  "txt", "plaintext", "mermaid", "vue", "svelte", "astro", "proto", "hcl", "nginx",
]);

function isUnknownCustom(type, info) {
  if (KNOWN_BLOCKS.has(type)) return true;
  if (/\b[\w-]+\s*=\s*\S/.test(info.slice(type.length))) return true;
  if (!COMMON_LANGS.has(type.toLowerCase()) && /^[A-Za-z][\w-]*$/.test(type)) return true;
  return false;
}

/* ========================================================================== *
 *  Per-block transforms — each takes (attrs, bodyLines) and returns an array
 *  of output markdown lines (the "block", to be pushed as one atomic unit).
 * ========================================================================== */

function transformDiagram(attrs, bodyLines) {
  const out = [];
  if (attrs.title) out.push(`**${attrs.title}**`);
  out.push("```mermaid");
  out.push(...bodyLines);
  out.push("```");
  return out;
}

function transformWireframe(attrs, _bodyLines) {
  const label = attrs.title || attrs.surface || "page";
  return [`> 🖼 *wireframe: ${label}* (interactive page only)`];
}

// filetree / data-model — line-readable bodies kept verbatim in a ```text
// fence, with the block's title bolded above when present (filetree has no
// title attribute in the format, so it never gets a caption line).
function transformTextBlock(attrs, bodyLines) {
  const out = [];
  if (attrs.title) out.push(`**${attrs.title}**`);
  out.push("```text");
  out.push(...bodyLines);
  out.push("```");
  return out;
}

// api-endpoint's most identifying info (method + path) lives in the fence's
// attrs, not its body — so a text-fence-only rendition would silently drop it.
// Ambiguity resolution: surface method+path alongside title (when present) on
// the caption line so the degraded block still reads.
function transformApiEndpoint(attrs, bodyLines) {
  const method = attrs.method ? String(attrs.method).toUpperCase() : "";
  const path = attrs.path || "";
  const title = attrs.title || "";
  const out = [];
  let header = "";
  if (title && method && path) header = `**${title}** — \`${method} ${path}\``;
  else if (title) header = `**${title}**`;
  else if (method && path) header = `**${method} ${path}**`;
  if (header) out.push(header);
  out.push("```text");
  out.push(...bodyLines);
  out.push("```");
  return out;
}

function parseStepsBody(bodyLines) {
  const steps = [];
  let cur = null;
  for (const raw of bodyLines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const titleM = /^#\s+(.*)$/.exec(line);
    if (titleM) { cur = { title: titleM[1].trim(), files: [], why: [] }; steps.push(cur); continue; }
    if (!cur) { cur = { title: "", files: [], why: [] }; steps.push(cur); }
    const fileM = /^(reuse|edit|new|delete)\s+(\S+)(?:\s+—\s+(.*)|\s+--\s+(.*))?\s*$/.exec(line.trim());
    if (fileM) {
      cur.files.push({ change: fileM[1], path: fileM[2], note: (fileM[3] || fileM[4] || "").trim() });
      continue;
    }
    const whyM = /^>\s?(.*)$/.exec(line.trim());
    if (whyM) { cur.why.push(whyM[1].trim()); continue; }
    cur.why.push(line.trim());
  }
  return steps;
}

function transformSteps(_attrs, bodyLines) {
  const steps = parseStepsBody(bodyLines);
  const out = [];
  steps.forEach((s, idx) => {
    const n = idx + 1;
    const marker = `${n}. `;
    const indent = " ".repeat(marker.length);
    out.push(`${marker}**${s.title || `Step ${n}`}**`);
    for (const f of s.files) {
      const notePart = f.note ? ` — ${f.note}` : "";
      out.push(`${indent}- **${f.change}** \`${f.path}\`${notePart}`);
    }
    for (const w of s.why) out.push(`${indent}> ${w}`);
  });
  return out;
}

// code — strip leading `@note line=N: text` lines, re-emit as blockquotes
// after the fence. Ambiguity resolution: a `file=` attr, like `diagram`'s
// `title`, is surfaced as a caption (an inline code path) above the fence so a
// snippet doesn't lose its file context — the spec doesn't call this out
// explicitly for `code`/`diff`, but dropping it silently seemed worse.
function transformCode(attrs, bodyLines) {
  const lang = attrs.lang || "";
  const notes = [];
  let idx = 0;
  while (idx < bodyLines.length) {
    const m = /^@note\s+line=(\d+)\s*:\s?(.*)$/.exec(bodyLines[idx]);
    if (!m) break;
    notes.push({ line: parseInt(m[1], 10), text: m[2] });
    idx++;
  }
  const codeLines = bodyLines.slice(idx);
  const out = [];
  if (attrs.file) out.push(`\`${attrs.file}\``);
  out.push("```" + lang);
  out.push(...codeLines);
  out.push("```");
  for (const n of notes) out.push(`> **line ${n.line}:** ${n.text}`);
  return out;
}

// diff — strip `@note: text` lines, re-emit as blockquotes after the fence.
function transformDiff(attrs, bodyLines) {
  const notes = [];
  const kept = [];
  for (const raw of bodyLines) {
    const m = /^@note:\s?(.*)$/.exec(raw);
    if (m) { notes.push(m[1]); continue; }
    kept.push(raw);
  }
  const out = [];
  if (attrs.file) out.push(`\`${attrs.file}\``);
  out.push("```diff");
  out.push(...kept);
  out.push("```");
  for (const n of notes) out.push(`> ${n}`);
  return out;
}

const TONE_TO_ALERT = { info: "NOTE", decision: "IMPORTANT", warning: "WARNING", risk: "CAUTION" };

function transformCallout(attrs, bodyLines) {
  const tone = TONE_TO_ALERT[attrs.tone] ? attrs.tone : "info";
  const alert = TONE_TO_ALERT[tone];
  const out = [`> [!${alert}]`];
  if (attrs.title) out.push(`> **${attrs.title}**`);
  for (const raw of bodyLines) out.push(raw.trim() === "" ? ">" : `> ${raw}`);
  while (out.length > 1 && out[out.length - 1] === ">") out.pop();
  return out;
}

function parseQuestionsBody(bodyLines) {
  const qs = [];
  let cur = null;
  for (const raw of bodyLines) {
    if (!raw.trim()) continue;
    const qM = /^#\s+(.*)$/.exec(raw.trim());
    if (qM) { cur = { text: qM[1].trim(), def: "" }; qs.push(cur); continue; }
    const dM = /^default:\s?(.*)$/i.exec(raw.trim());
    if (dM && cur) { cur.def = dM[1].trim(); continue; }
    if (cur) cur.text += " " + raw.trim();
  }
  return qs;
}

function transformQuestions(_attrs, bodyLines) {
  const qs = parseQuestionsBody(bodyLines);
  const out = ["### Open questions", ""];
  for (const q of qs) {
    out.push(`- **${q.text}**`);
    if (q.def) out.push(`  - _default:_ ${q.def}`);
  }
  return out;
}

function transformKnownBlock(type, attrs, bodyLines) {
  switch (type) {
    case "diagram": return transformDiagram(attrs, bodyLines);
    case "wireframe": return transformWireframe(attrs, bodyLines);
    case "steps": return transformSteps(attrs, bodyLines);
    case "filetree": return transformTextBlock({}, bodyLines);
    case "data-model": return transformTextBlock(attrs, bodyLines);
    case "api-endpoint": return transformApiEndpoint(attrs, bodyLines);
    case "code": return transformCode(attrs, bodyLines);
    case "diff": return transformDiff(attrs, bodyLines);
    case "callout": return transformCallout(attrs, bodyLines);
    case "questions": return transformQuestions(attrs, bodyLines);
    default: return [];
  }
}

/* ========================================================================== *
 *  Fence-aware line scanner + grouping directives
 * ========================================================================== */

// Push a block's lines as one atomic unit, with a blank line before (if the
// output doesn't already end on one) and after — keeps generated blocks
// separated from surrounding prose/fences without ever touching content
// *inside* a fence (blank lines inside a block's own fence are untouched,
// since they're part of `blockLines` itself, pushed verbatim in one go).
function pushBlock(out, blockLines) {
  if (out.length && out[out.length - 1].trim() !== "") out.push("");
  out.push(...blockLines);
  out.push("");
}

// Walk `lines` line-by-line, fence-length-aware (mirrors render.mjs's
// extractBlocks scan): recognized custom fences are transformed in place;
// unrecognized "custom-shaped" fences are wrapped as a labeled ```text fence;
// standard language fences and directive-free prose pass through untouched.
// `<!-- chapter/collapsible/tabs -->` directives are only ever considered
// OUTSIDE a fence, because fenced bodies are consumed atomically before the
// scanner ever inspects their inner lines.
function transformLines(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fenceM = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceM) {
      const fence = fenceM[2];
      const info = fenceM[3].trim();
      const closeRe = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
      let j = i + 1;
      const bodyLines = [];
      let closed = false;
      while (j < lines.length) {
        if (closeRe.test(lines[j])) { closed = true; break; }
        bodyLines.push(lines[j]);
        j++;
      }
      const { type, attrs } = parseInfo(info);

      if (type && KNOWN_BLOCKS.has(type)) {
        pushBlock(out, transformKnownBlock(type, attrs, bodyLines));
        i = closed ? j + 1 : j;
        continue;
      }
      if (type && isUnknownCustom(type, info)) {
        pushBlock(out, [`*(block: ${type})*`, "```text", ...bodyLines, "```"]);
        i = closed ? j + 1 : j;
        continue;
      }
      // Standard language fence (or no info string) — pass through untouched.
      out.push(line);
      out.push(...bodyLines);
      if (closed) out.push(lines[j]);
      i = closed ? j + 1 : j;
      continue;
    }

    const chapterM = /^\s*<!--\s*chapter:\s*(.+?)\s*-->\s*$/.exec(line);
    if (chapterM && !/^end$/i.test(chapterM[1])) {
      pushBlock(out, [`## ${chapterM[1].trim()}`]);
      i++;
      continue;
    }

    const collM = /^\s*<!--\s*collapsible:\s*(.*?)\s*-->\s*$/.exec(line);
    if (collM && !/^end$/i.test(collM[1])) {
      const label = collM[1].trim();
      let j = i + 1;
      const inner = [];
      while (j < lines.length && !/^\s*<!--\s*collapsible:end\s*-->\s*$/.test(lines[j])) {
        inner.push(lines[j]);
        j++;
      }
      const innerLines = transformLines(inner);
      pushBlock(out, ["<details>", `<summary>${label}</summary>`, "", ...innerLines, "", "</details>"]);
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    const tabsStartM = /^\s*<!--\s*tabs:start\s*-->\s*$/.exec(line);
    if (tabsStartM) {
      let j = i + 1;
      const tabs = [];
      let cur = null;
      while (j < lines.length && !/^\s*<!--\s*tabs:end\s*-->\s*$/.test(lines[j])) {
        const tabM = /^\s*<!--\s*tab:\s*(.*?)\s*-->\s*$/.exec(lines[j]);
        if (tabM) { cur = { label: tabM[1].trim(), content: [] }; tabs.push(cur); j++; continue; }
        if (cur) cur.content.push(lines[j]);
        j++;
      }
      const sectionLines = [];
      tabs.forEach((t) => {
        if (sectionLines.length) sectionLines.push("");
        sectionLines.push(`**${t.label}**`, "", ...transformLines(t.content));
      });
      pushBlock(out, sectionLines);
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    out.push(line);
    i++;
  }
  return out;
}

/* ========================================================================== *
 *  Size guard — GitHub comment bodies cap at 65536 chars.
 * ========================================================================== */

const HARD_LIMIT = 65536;
const SOFT_LIMIT = 60000;
const TRUNCATION_NOTICE = "\n\n*…truncated — see the full interactive page.*\n";

// Find every position right after a blank line that sits OUTSIDE any fence —
// the only safe places to cut without leaving a fence open (which would break
// rendering of everything that follows it).
function findSafeCutPoints(text) {
  const lines = text.split("\n");
  const cuts = [0];
  let pos = 0;
  let fenceChar = null, fenceLen = 0;
  for (const line of lines) {
    const fm = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fm) {
      const ch = fm[2][0], len = fm[2].length;
      if (!fenceChar) { fenceChar = ch; fenceLen = len; }
      else if (ch === fenceChar && len >= fenceLen) { fenceChar = null; fenceLen = 0; }
    }
    pos += line.length + 1;
    if (!fenceChar && line.trim() === "") cuts.push(pos);
  }
  cuts.push(text.length);
  return cuts;
}

function applySizeGuard(text) {
  if (text.length <= SOFT_LIMIT) return text;
  const cuts = findSafeCutPoints(text);
  let cut = 0;
  for (const c of cuts) {
    if (c <= SOFT_LIMIT) cut = c;
    else break;
  }
  if (cut === 0) cut = SOFT_LIMIT; // pathological: no blank line before the limit
  const truncated = text.slice(0, cut).replace(/\s+$/, "") + TRUNCATION_NOTICE;
  // Extremely defensive: should never trigger given SOFT_LIMIT's margin below
  // HARD_LIMIT, but never emit something over the hard cap either way.
  return truncated.length <= HARD_LIMIT ? truncated : truncated.slice(0, HARD_LIMIT);
}

/* ========================================================================== *
 *  Public API
 * ========================================================================== */

// Collapse runs of blank lines OUTSIDE fences to a single blank line. A blind
// /\n{3,}/ squeeze would also eat blank lines *inside* a fence (a diff/code
// body with intentional blank lines), corrupting content we promised to keep
// unchanged — so this walks lines with the same fence tracking as the scanner.
function squeezeBlankLines(lines) {
  const out = [];
  let fenceChar = null, fenceLen = 0;
  let prevBlank = false;
  for (const line of lines) {
    const fm = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fm) {
      const ch = fm[1][0], len = fm[1].length;
      if (!fenceChar) { fenceChar = ch; fenceLen = len; }
      else if (ch === fenceChar && len >= fenceLen) { fenceChar = null; fenceLen = 0; }
    }
    const blank = !fenceChar && !fm && line.trim() === "";
    if (blank && prevBlank) continue;
    out.push(line);
    prevBlank = blank;
  }
  return out;
}

export function buildGithubMarkdown(source) {
  const src = String(source ?? "");
  const { frontmatter, body } = parseFrontmatter(src);
  const headerLines = buildFrontmatterLines(frontmatter);
  const bodyLines = body.split(/\r?\n/);
  const transformed = transformLines(bodyLines);

  const allLines = headerLines.length ? [...headerLines, "", ...transformed] : transformed;
  const text = squeezeBlankLines(allLines).join("\n").trim() + "\n";
  return applySizeGuard(text);
}

/* ========================================================================== *
 *  CLI
 * ========================================================================== */

const USAGE = `usage: node github-md.mjs <plan.md> [--out <path>]

  <plan.md>     path to a plan written in the visual-plan format
  --out <path>  output path (default: <plan without .md>.github.md)`;

function parseArgs(argv) {
  const args = { input: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a.startsWith("--out=")) args.out = a.slice("--out=".length);
    else if (a === "-h" || a === "--help") args.help = true;
    else if (!a.startsWith("-") && !args.input) args.input = a;
  }
  return args;
}

function main() {
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

  const md = buildGithubMarkdown(source);
  const outPath = args.out ? resolve(args.out) : inputPath.replace(/\.md$/i, "") + ".github.md";
  try {
    writeFileSync(outPath, md, "utf8");
  } catch (e) {
    console.error(`error: cannot write ${outPath}: ${e.message}`);
    process.exit(1);
  }
  console.log(`github: ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
