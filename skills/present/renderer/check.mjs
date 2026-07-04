// check.mjs — best-effort mermaid diagram validator.
//
// render.mjs never executes Mermaid in Node: a `diagram` block is emitted as
// raw source inside a `<pre class="mermaid">` and only ever parsed client-side,
// in the browser, when the page is opened. That means a Mermaid syntax error
// (e.g. a semicolon inside a sequence-diagram message — a real bug we hit)
// currently ships silently: render.mjs succeeds, the HTML looks fine, and the
// diagram is broken only once a human opens it. This script closes that gap by
// actually opening the rendered page in a local headless Chromium (if one can
// be found) and inspecting the live DOM for diagrams that failed to render.
//
// Zero dependencies: only node:fs, node:path, node:os, node:child_process.
//
// Usage: node check.mjs <rendered.html> [--browser <path>] [--timeout-ms N]
//
//   <rendered.html>   path to an HTML file produced by render.mjs / recap.mjs
//   --browser <path>  explicit Chromium-family binary to drive (skips discovery)
//   --timeout-ms N    --virtual-time-budget given to the browser (default 10000)
//
// Exit codes:
//   0  every diagram rendered an <svg> (or there were no diagrams, or the
//      check was skipped because no local headless Chromium could be found)
//   1  at least one diagram failed to render, or the browser/dump-dom itself
//      failed (crashed, produced no output, or a non-existent --browser /
//      $PF_BROWSER override was given — an explicit override that's wrong is a
//      configuration error, NOT the same as "none found", which only ever
//      happens during best-effort auto-discovery and just skips)
//   2  usage error (bad flags, missing argument, no such input file)

import { existsSync, readdirSync, accessSync, constants } from "node:fs";
import { join, resolve, delimiter } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const USAGE = `usage: node check.mjs <rendered.html> [--browser <path>] [--timeout-ms N]

  <rendered.html>   path to an HTML file produced by render.mjs / recap.mjs
  --browser <path>  explicit headless-Chromium-family binary to use
  --timeout-ms N    virtual-time-budget given to the browser, in ms (default 10000)

Best-effort by design: if no local headless Chromium can be found (and neither
--browser nor $PF_BROWSER was given), the check is skipped (exit 0) rather than
treated as a hard dependency. An explicit --browser/$PF_BROWSER that does not
point to a real executable is a configuration error (exit 1), not a skip.`;

/* ========================================================================== *
 *  argument parsing
 * ========================================================================== */

function parseArgs(argv) {
  const a = { html: null, browser: null, timeoutMs: 10000 };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--browser") a.browser = argv[++i];
    else if (x.startsWith("--browser=")) a.browser = x.slice("--browser=".length);
    else if (x === "--timeout-ms") a.timeoutMs = parseInt(argv[++i], 10);
    else if (x.startsWith("--timeout-ms=")) a.timeoutMs = parseInt(x.slice("--timeout-ms=".length), 10);
    else if (x === "-h" || x === "--help") a.help = true;
    else if (!x.startsWith("-") && !a.html) a.html = x;
    else return { error: `unrecognized argument: ${x}` };
  }
  if (!Number.isFinite(a.timeoutMs) || a.timeoutMs <= 0) a.timeoutMs = 10000;
  return a;
}

/* ========================================================================== *
 *  browser discovery
 * ========================================================================== */

function isExecutableFile(p) {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

// Discovery order (first hit wins): --browser flag; $PF_BROWSER env; probe PATH
// for common Chromium-family binaries; then a Playwright browser cache glob.
const PATH_CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "msedge", "brave"];

function probePath() {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const name of PATH_CANDIDATES) {
    for (const dir of dirs) {
      const p = join(dir, name);
      if (isExecutableFile(p)) return p;
    }
  }
  return null;
}

// Playwright installs browsers under ~/.cache/ms-playwright/<chromium*>/<chrome-*>/,
// e.g. chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell
// or chromium-1091/chrome-linux/chrome. Glob both generically (no hardcoded build
// number) and pick the newest install by sorting directory names descending.
function probePlaywrightCache() {
  const base = join(homedir(), ".cache", "ms-playwright");
  let topEntries;
  try { topEntries = readdirSync(base, { withFileTypes: true }); } catch { return null; }
  const chromiumDirs = topEntries
    .filter((e) => e.isDirectory() && /^chromium/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const dir of chromiumDirs) {
    let subEntries;
    try { subEntries = readdirSync(join(base, dir), { withFileTypes: true }); } catch { continue; }
    const chromeDirs = subEntries
      .filter((e) => e.isDirectory() && /^chrome-/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const sub of chromeDirs) {
      for (const bin of ["chrome-headless-shell", "chrome"]) {
        const p = join(base, dir, sub, bin);
        if (isExecutableFile(p)) return p;
      }
    }
  }
  return null;
}

// Returns { path, source, explicit } or null. `explicit` marks a user-given
// override (--browser / $PF_BROWSER): those are never silently treated as
// "not found" — an invalid explicit path is a hard error, not a skip.
function findBrowser(explicitFlag) {
  if (explicitFlag) return { path: explicitFlag, source: "--browser", explicit: true };
  if (process.env.PF_BROWSER) return { path: process.env.PF_BROWSER, source: "$PF_BROWSER", explicit: true };
  const fromPath = probePath();
  if (fromPath) return { path: fromPath, source: "PATH", explicit: false };
  const fromCache = probePlaywrightCache();
  if (fromCache) return { path: fromCache, source: "ms-playwright cache", explicit: false };
  return null;
}

/* ========================================================================== *
 *  diagram inspection
 * ========================================================================== */

// Split the dumped DOM on each diagram figure's opening tag and inspect ONLY
// that slice, up to its closing </figure>.
//
// Why scoped to the figure: in the default (non-lean) build, render.mjs
// inlines the ENTIRE Mermaid bundle as page <script> source, and that bundle's
// own JS contains the literal string "Syntax error in text" as part of its
// internal error-rendering code. Searching the whole dumped document for that
// string would flag every non-lean page as a failure, regardless of whether
// any diagram actually broke. A <figure> element cannot contain a <script>, so
// scoping the search to each figure's own segment makes that false positive
// structurally impossible while still catching a real per-diagram failure
// (Mermaid renders a visible "Syntax error in text" SVG in place, or — if it
// throws before producing anything — leaves the raw `<pre class="mermaid">`
// unprocessed with no `<svg>` at all).
// Matched on the opening tag as a whole (not a fixed literal string): render.mjs
// may add more attributes to a diagram figure over time (e.g. an anchor id) —
// as long as `data-block="diagram"` is present somewhere in the tag, this still
// finds it, the same way the renderer's own tests match `<pre class="mermaid"`
// without requiring it to be the last attribute.
const FIGURE_OPEN_RE = /<figure\b[^>]*\bdata-block="diagram"[^>]*>/;

export function checkDiagrams(dom) {
  const parts = dom.split(FIGURE_OPEN_RE);
  const failures = [];
  let total = 0; // figures actually checked (excludes lean, which is never executed)
  let skipped = 0; // lean figures encountered
  for (let i = 1; i < parts.length; i++) {
    const end = parts[i].indexOf("</figure>");
    const segment = end === -1 ? parts[i] : parts[i].slice(0, end);

    const captionM = /<figcaption>([\s\S]*?)<\/figcaption>/.exec(segment);
    const caption = captionM ? captionM[1].replace(/<[^>]*>/g, "").trim() : "";
    const label = caption || `diagram #${i}`;

    // --lean output never runs Mermaid at all — nothing to check.
    if (segment.includes('<pre class="diagram-lean"')) { skipped++; continue; }
    total++;

    const hasSyntaxError = segment.includes("Syntax error in text");
    const hasMermaidSource = /<pre class="mermaid"/.test(segment);
    const hasSvg = /<svg[\s>]/.test(segment);

    if (hasSyntaxError || (hasMermaidSource && !hasSvg)) failures.push(label);
  }
  return { total, skipped, failures };
}

/* ========================================================================== *
 *  CLI
 * ========================================================================== */

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(`error: ${args.error}`); console.error(USAGE); process.exit(2); }
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (!args.html) { console.error("error: missing <rendered.html> argument"); console.error(USAGE); process.exit(2); }

  const htmlPath = resolve(args.html);
  if (!existsSync(htmlPath)) { console.error(`error: no such file: ${htmlPath}`); process.exit(2); }

  const found = findBrowser(args.browser);
  if (!found) {
    console.log("check skipped: no local headless Chromium found");
    process.exit(0);
  }
  if (!isExecutableFile(found.path)) {
    if (found.explicit) {
      console.error(`error: ${found.source} does not point to an executable: ${found.path}`);
      process.exit(1);
    }
    // Auto-discovery only ever returns paths it already verified are
    // executable, so this branch is unreachable for it — kept as a guard.
    console.log("check skipped: no local headless Chromium found");
    process.exit(0);
  }

  let dom;
  try {
    dom = execFileSync(
      found.path,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        `--virtual-time-budget=${args.timeoutMs}`,
        "--dump-dom",
        `file://${htmlPath}`,
      ],
      { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: args.timeoutMs + 30000 },
    );
  } catch (e) {
    const msg = (e && e.stderr) ? String(e.stderr).trim() : (e && e.message) || String(e);
    console.error(`error: browser failed to render the page (${found.source}: ${found.path}): ${msg}`);
    process.exit(1);
  }

  if (!dom || !dom.trim()) {
    console.error(`error: --dump-dom produced no output (${found.source}: ${found.path})`);
    process.exit(1);
  }

  const { total, skipped, failures } = checkDiagrams(dom);
  const skippedNote = skipped ? ` (+${skipped} lean, skipped)` : "";
  if (failures.length) {
    for (const f of failures) console.error(`failed: ${f}`);
    console.log(`checked ${total} diagram(s)${skippedNote}: ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`checked ${total} diagram(s)${skippedNote}: all rendered`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
