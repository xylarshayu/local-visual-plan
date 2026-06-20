// recap.mjs — visual-recap front-end.
//
// Turns a git diff into a `recap.md` in the visual-plan format, then renders it
// through the SAME engine (render.mjs / renderPlan). A recap is a visual plan
// built FROM a diff instead of toward one: a file-tree of what changed plus the
// key per-file diffs, as one self-contained, offline, interactive HTML page.
//
// Programmatic API (pure, testable — no git, no fs):
//   buildRecapMarkdown(collected, { maxFiles = 8 }) => string  (recap.md text)
// Git collection:
//   collectDiff({ range, staged, cwd }) => { title, range, files, diffs, summary }
//
// CLI:
//   node recap.mjs [<range>] [--staged] [--out <p>] [--lean] [--open] [--max-files N]
//     <range>   A..B, a single <ref> (compared to the working tree), or omitted
//               (working tree + index vs HEAD). Use base..head for a PR/branch.

import { readFileSync, writeFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { renderPlan } from "./render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_LINES_PER_FILE = 220;

/* ========================================================================== *
 *  git collection
 * ========================================================================== */

function git(args, cwd) {
  // stderr piped (not inherited) so caught probes — e.g. rev-parse on an unborn
  // HEAD — don't leak git's "fatal:" chatter to the console.
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
// git with paths emitted raw (no octal-escaping / quoting) — for diff + ls-files.
function gitRaw(args, cwd) {
  return git(["-c", "core.quotePath=false", ...args], cwd);
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's canonical empty tree

// Trailing args for `git diff …`. `hasHead` is false in an unborn repo (no
// commits yet), where we diff against the empty tree so brand-new staged files
// still show as additions.
function diffArgs(range, staged, hasHead) {
  if (staged) return ["--cached"];
  if (range && range.trim()) return [range.trim()];
  return [hasHead ? "HEAD" : EMPTY_TREE];
}

const STATUS_FLAG = { A: "+", M: "~", D: "-", R: "~", C: "~", T: "~" };
const STATUS_WORD = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "modified" };

function stripPrefix(p) { return p === "/dev/null" ? null : p.replace(/^[ab]\//, ""); }
function countChurn(hunks) {
  let c = 0;
  for (const l of hunks.split("\n")) if (l[0] === "+" || l[0] === "-") c++;
  return c;
}

// Split a full `git diff` blob into per-file { path, binary, hunks, churn }.
// The path is taken from the unambiguous `+++ b/<path>` / `--- a/<path>` lines,
// NOT the `diff --git a/x b/x` header (which is ambiguous for any path
// containing " b/"). Requires core.quotePath=false so paths arrive raw. `hunks`
// is the body from the first @@ onward; "\ No newline" markers are dropped.
function splitDiff(full) {
  const out = new Map();
  const blocks = full.split(/\n(?=diff --git )/);
  for (const block of blocks) {
    if (!block.startsWith("diff --git")) continue;
    const lines = block.split("\n");
    let oldP = null, newP = null;
    for (const l of lines) {
      if (l.startsWith("@@ ")) break;
      if (l.startsWith("--- ")) oldP = stripPrefix(l.slice(4).replace(/\t.*$/, ""));
      else if (l.startsWith("+++ ")) newP = stripPrefix(l.slice(4).replace(/\t.*$/, ""));
    }
    const path = newP || oldP;
    if (!path) continue; // binary / no ---/+++ header — name-status still lists it
    const at = lines.findIndex((l) => /^@@ /.test(l));
    const binary = at === -1;
    const hunks = binary ? "" : lines.slice(at).filter((l) => !/^\\ No newline at end of file/.test(l)).join("\n");
    out.set(path, { path, binary, hunks, churn: countChurn(hunks) });
  }
  return out;
}

export function collectDiff({ range = "", staged = false, cwd = process.cwd() } = {}) {
  // Validate we are in a work tree (throws a clean error otherwise).
  git(["rev-parse", "--is-inside-work-tree"], cwd);
  // Reject a range git would read as an option (arg-injection guard for the
  // exported API; the CLI never assigns a dash-leading token to range).
  if (range && range.trim().startsWith("-")) throw new Error(`invalid range: ${range.trim()}`);

  let hasHead = true;
  try { git(["rev-parse", "--verify", "-q", "HEAD"], cwd); } catch { hasHead = false; }
  const da = diffArgs(range, staged, hasHead);

  // NUL-delimited name-status → unambiguous status + paths (spaces, unicode,
  // renames). Tokens: STATUS \0 path  (or  R### \0 old \0 new).
  const ns = gitRaw(["diff", ...da, "-z", "--name-status"], cwd).split("\u0000");
  const full = gitRaw(["diff", ...da], cwd);
  const patches = splitDiff(full);

  const files = [];
  for (let i = 0; i < ns.length; ) {
    const code = ns[i++];
    if (!code) continue; // trailing empty token
    const letter = code[0];
    let path, oldPath;
    if (letter === "R" || letter === "C") { oldPath = ns[i++]; path = ns[i++]; }
    else { path = ns[i++]; }
    if (path === undefined) break;
    files.push({ letter, status: STATUS_WORD[letter] || "modified", flag: STATUS_FLAG[letter] || "~", path, oldPath, churn: 0 });
  }

  // `git diff HEAD` excludes untracked files, but a working-tree recap should
  // show brand-new files (often the most worth recapping). Synthesize an
  // all-added diff for each untracked, non-ignored file. (--staged and explicit
  // ranges already account for added files, so only the default mode needs this.)
  if (!range.trim() && !staged) {
    let untracked = [];
    try { untracked = gitRaw(["ls-files", "--others", "--exclude-standard", "-z"], cwd).split("\u0000").filter(Boolean); }
    catch { /* none */ }
    for (const path of untracked) {
      if (patches.has(path)) continue;
      let buf;
      try { buf = readFileSync(join(cwd, path)); } catch { continue; }
      const binary = buf.includes(0); // a NUL byte marks it binary
      const norm = binary ? "" : buf.toString("utf8").replace(/\r\n/g, "\n");
      const ls = norm === "" ? [] : norm.replace(/\n$/, "").split("\n");
      const n = ls.length;
      const hunks = n ? `@@ -0,0 +1,${n} @@\n` + ls.map((l) => "+" + l).join("\n") : "";
      patches.set(path, { path, binary, hunks, churn: n });
      files.push({ letter: "A", status: "added", flag: "+", path, oldPath: undefined, churn: n });
    }
  }

  // churn comes from each file's own patch, so a rename-with-edits ranks by its
  // real churn instead of being mis-keyed to 0.
  for (const f of files) f.churn = patches.get(f.path)?.churn ?? 0;

  // total summary from shortstat (tracked changes; untracked additions add to
  // the file count below but not to this insertion/deletion line)
  let summary = "";
  try { summary = gitRaw(["diff", ...da, "--shortstat"], cwd).trim(); } catch { /* none */ }

  let title;
  if (range && range.trim()) title = `Recap: ${range.trim()}`;
  else {
    let branch = "";
    try { branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim(); } catch { /* detached */ }
    title = staged ? "Recap: staged changes" : `Recap: working tree${branch && branch !== "HEAD" ? ` on ${branch}` : ""}`;
  }

  return { title, range: range || (staged ? "--staged" : "working tree vs HEAD"), files, patches, summary };
}

/* ========================================================================== *
 *  recap.md assembly (pure)
 * ========================================================================== */

function clampHunks(hunks) {
  const lines = hunks.split("\n");
  if (lines.length <= MAX_LINES_PER_FILE) return hunks;
  const kept = lines.slice(0, MAX_LINES_PER_FILE);
  kept.push(`@note: … diff truncated — ${lines.length - MAX_LINES_PER_FILE} more lines in this file.`);
  return kept.join("\n");
}

export function buildRecapMarkdown(collected, { maxFiles = 8 } = {}) {
  const { title, range, files, patches, summary } = collected;
  const lines = [];
  lines.push("---");
  lines.push(`title: ${title}`);
  // Lead with our own file count (includes untracked); append the tracked
  // insertion/deletion tail from shortstat when present.
  const churn = summary.replace(/^\d+\s+files?\s+changed,?\s*/, "").trim();
  const obj = `${files.length} file(s) changed${churn ? ", " + churn : ""}`;
  lines.push(`objective: ${obj} (${range}).`);
  lines.push("---");
  lines.push("");

  if (!files.length) {
    lines.push(`No changes in \`${range}\`.`);
    lines.push("");
    return lines.join("\n");
  }

  // file-tree of every changed file (flat, full paths, with change flags)
  lines.push("```filetree");
  for (const f of files) {
    const note = f.oldPath ? ` — ${f.status}, was ${f.oldPath}` : f.status !== "modified" ? ` — ${f.status}` : "";
    lines.push(`${f.flag} ${f.path}${note}`);
  }
  lines.push("```");
  lines.push("");

  // key changes: the highest-churn files, one diff per tab
  const ranked = [...files]
    .filter((f) => f.status !== "deleted") // a deleted file's "after" is empty; tree already shows it
    .map((f) => ({ f, p: patches.get(f.path) }))
    .filter((x) => x.p && !x.p.binary && x.p.hunks.trim())
    .sort((a, b) => b.f.churn - a.f.churn);

  const shown = ranked.slice(0, maxFiles);
  if (shown.length) {
    lines.push("## Key changes");
    lines.push("");
    lines.push("<!-- tabs:start -->");
    for (const { f, p } of shown) {
      lines.push(`<!-- tab: ${basename(f.path)} -->`);
      lines.push("");
      lines.push("```diff file=" + quoteAttr(f.path) + " mode=split");
      lines.push(clampHunks(p.hunks).replace(/\n+$/, ""));
      lines.push("```");
      lines.push("");
    }
    lines.push("<!-- tabs:end -->");
    lines.push("");
    const omitted = ranked.length - shown.length;
    if (omitted > 0) {
      lines.push(`_+${omitted} more changed file(s) with diffs — see the file tree above._`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

function quoteAttr(v) {
  return /[\\s="]/.test(v) ? `"${v.replace(/"/g, "")}"` : v;
}

/* ========================================================================== *
 *  output + CLI
 * ========================================================================== */

function isWritable(dir) {
  try { accessSync(dir, constants.W_OK); return true; } catch { return false; }
}
function defaultOutPath(slug) {
  const cwd = process.cwd();
  const base = isWritable(cwd) ? join(cwd, ".visual-plans") : join("/tmp", "visual-plans");
  return join(base, slug, "index.html");
}

function parseArgs(argv) {
  const a = { range: "", staged: false, out: null, lean: false, open: false, maxFiles: 8 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--staged" || x === "--cached") a.staged = true;
    else if (x === "--lean") a.lean = true;
    else if (x === "--open") a.open = true;
    else if (x === "--no-open") a.open = false;
    else if (x === "--out") a.out = argv[++i];
    else if (x.startsWith("--out=")) a.out = x.slice(6);
    else if (x === "--max-files") a.maxFiles = parseInt(argv[++i], 10) || 8;
    else if (x.startsWith("--max-files=")) a.maxFiles = parseInt(x.slice(12), 10) || 8;
    else if (x === "-h" || x === "--help") a.help = true;
    else if (!x.startsWith("-") && !a.range) a.range = x;
  }
  return a;
}

const USAGE = `usage: node recap.mjs [<range>] [--staged] [--out <path>] [--lean] [--open] [--max-files N]

  <range>        A..B, a single <ref> (vs the working tree), or omitted (working
                 tree + index vs HEAD). Use base..head for a branch/PR recap.
  --staged       recap only the staged changes (git diff --cached)
  --out <path>   output HTML (default: ./.visual-plans/<slug>/index.html)
  --lean         omit the inlined mermaid bundle
  --open         open the produced file in the browser
  --max-files N  number of per-file diff tabs to include (default 8)`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }

  let collected;
  try {
    collected = collectDiff({ range: args.range, staged: args.staged });
  } catch (e) {
    const msg = (e && e.stderr) ? String(e.stderr).trim() : (e && e.message) || String(e);
    console.error(`error: could not collect git diff: ${msg}`);
    process.exit(1);
  }

  const md = buildRecapMarkdown(collected, { maxFiles: args.maxFiles });
  let result;
  try {
    result = renderPlan(md, { lean: args.lean });
  } catch (e) {
    console.error(`error: failed to render recap: ${e.stack || e.message}`);
    process.exit(1);
  }

  const outPath = args.out ? resolve(args.out) : defaultOutPath(result.slug);
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.html, "utf8");
    // also drop the recap.md source next to it for transparency / re-rendering
    writeFileSync(join(dirname(outPath), "recap.md"), md, "utf8");
  } catch (e) {
    console.error(`error: cannot write ${outPath}: ${e.message}`);
    process.exit(1);
  }

  for (const w of result.warnings) console.error(`warning: ${w}`);
  console.log(`wrote ${outPath}`);
  console.log(`title: ${result.title}`);
  console.log(`files: ${collected.files.length}${collected.summary ? "  (" + collected.summary + ")" : ""}`);

  if (args.open) {
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
