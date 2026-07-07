// run.mjs — the eval runner for the present / present-plan / present-recap skills.
//
// The engine (skills/present/renderer) is deterministic and heavily unit-tested.
// This runner measures the OTHER failure surface: the model's behavior WITH the
// skills. Two suites, per-case isolated workspaces, all graded by code (no LLM
// judge):
//
//   triggers  — does the right skill fire (and stay quiet when it shouldn't)?
//   behavior  — with the skill loaded, does the agent author a valid page /
//               respect the discipline rules? Graded via renderPlan() warnings,
//               check.mjs, plain string assertions, and tool-use inspection.
//
// Zero npm install. The only heavy dependency is the `claude` CLI (must be on
// PATH) and, for `render-clean`, the sibling renderer at
// skills/present/renderer/render.mjs.
//
// ── Isolation (the load-bearing trick) ───────────────────────────────────────
// There is no `--skill` flag, and this repo's three skills are typically ALSO
// installed in the user's ~/.claude/skills (plus dozens of unrelated skills).
// If we just ran `claude -p` in a fresh dir those global skills would leak in
// and corrupt every trigger measurement. So each run gets:
//   • an isolated CLAUDE_CONFIG_DIR (a throwaway dir with NO skills/ subdir) so
//     NONE of the user's user-level skills load — verified empirically: the
//     stream-json `init` event's `skills` array then contains only the built-in
//     plugin skills plus whatever we place in the workspace's own
//     .claude/skills. Auth is preserved by copying `.credentials.json` (and
//     settings.json) from the real config dir into the isolated one.
//   • a throwaway workspace whose .claude/skills/ is populated with EXACTLY our
//     three skills using install.sh's copy semantics (or left empty for a
//     baseline/no-skill run). Project-level skills are discovered from the cwd.
//
// ── Permission strategy ──────────────────────────────────────────────────────
// `--dangerously-skip-permissions`. Rationale: the workspace is a throwaway temp
// dir we created and delete; `-p` is non-interactive so any permission PROMPT
// would hang the run forever; and behavior cases must be free to run git, render
// (Bash → node render.mjs) and Write files. `--permission-mode acceptEdits`
// would still prompt on Bash/unlisted tools, and maintaining an --allowedTools
// allowlist that covers everything the skills legitimately do (Bash with
// arbitrary node invocations, Write, Read, git) reduces to "allow everything"
// anyway. Skipping permissions in a sandboxed throwaway dir is the honest,
// working choice. (The isolated CLAUDE_CONFIG_DIR credentials copy is removed on
// cleanup unless --keep-workspaces.)
//
// ── stream-json event shape (empirically verified 2026-07-04, CLI 2.1.201) ────
// Lines are JSON. The shapes this runner depends on:
//   {type:"system", subtype:"init", skills:[...], ...}         (exactly one)
//   {type:"assistant", message:{content:[ ...blocks ]}, ...}   (zero or more)
//     a block may be {type:"tool_use", name:"Skill", input:{skill:"present-recap"}}
//     or a normal tool {type:"tool_use", name:"Bash"|"Edit"|..., input:{...}}
//   {type:"result", subtype:"success"|"error_max_turns"|..., result:"<text>",
//     total_cost_usd:<number>, is_error:<bool>}                (exactly one)
// A SKILL invocation is a tool_use whose name === "Skill"; the invoked skill is
// input.skill. If those anchors are missing the parser fails LOUDLY with a
// "CLI output shape changed" error and a path to the raw dump.
//
// CLI:
//   node evals/run.mjs [triggers|behavior|all] [--cases-file <path>]
//     [--cases <id-substring>] [--model <m>] [--matrix] [--runs N]
//     [--max-turns N] [--keep-workspaces] [--dry-run] [--out <path>] [--label <s>]

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync,
  cpSync, copyFileSync,
} from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));          // .../evals
const REPO_ROOT = resolve(HERE, "..");                        // repo root
const SKILLS_SRC = join(REPO_ROOT, "skills");                 // present, present-plan, present-recap
const RENDER_MJS = join(SKILLS_SRC, "present", "renderer", "render.mjs");
const CHECK_MJS = join(SKILLS_SRC, "present", "renderer", "check.mjs");

const OUR_SKILLS = ["present", "present-plan", "present-recap"];
const OUR_SKILLS_SET = new Set(OUR_SKILLS);

const DEFAULTS = {
  model: "sonnet",              // the model users actually run; pass --model haiku for cheap loops
  triggerRuns: 3,
  behaviorRuns: 1,
  triggerMaxTurns: 4,
  behaviorMaxTurns: 24,
};

/* ========================================================================== *
 *  small utilities
 * ========================================================================== */

function die(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function today() {
  return new Date().toISOString().slice(0, 10); // yyyy-mm-dd (UTC)
}

// A loud, structured failure for when the CLI's stream-json no longer matches
// what the parser hard-codes. Always includes a path to the raw dump.
function shapeError(what, dumpPath) {
  return new Error(
    `CLI output shape changed: ${what}\n` +
    `  raw stream-json dumped to: ${dumpPath}\n` +
    `  Re-verify the event shape (see the header comment in evals/run.mjs) and ` +
    `update the parser.`,
  );
}

/* ========================================================================== *
 *  CLI parsing
 * ========================================================================== */

const USAGE = `usage: node evals/run.mjs [triggers|behavior|all] [options]

  suite                which suite to run (default: all)
  --cases-file <path>  cases JSON to load (default: evals/cases/<suite>.json)
  --cases <substr>     only run cases whose id contains <substr>
  --split <s>          triggers only: run just train or validation cases
                       (the README's routine run: --split validation --model haiku)
  --model <m>          model alias, e.g. haiku | sonnet (default: ${DEFAULTS.model})
  --matrix             run the suite once per model in [haiku, sonnet]
  --runs N             runs per case (default: ${DEFAULTS.triggerRuns} triggers / ${DEFAULTS.behaviorRuns} behavior)
  --max-turns N        cap turns per invocation (default: ${DEFAULTS.triggerMaxTurns} triggers / ${DEFAULTS.behaviorMaxTurns} behavior)
  --keep-workspaces    do not delete the throwaway workspaces / config dir
  --dry-run            print what would run; spawn no models, spend nothing
  --out <path>         results JSON path (default: evals/results/<date>-<label|run>.json)
  --label <s>          label for the default results filename`;

function parseArgs(argv) {
  const a = {
    suite: null, casesFile: null, casesFilter: null, split: null, model: null, matrix: false,
    runs: null, maxTurns: null, keep: false, dryRun: false, out: null, label: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const takeVal = (name) => {
      const v = argv[++i];
      if (v === undefined) die(`${name} requires a value\n\n${USAGE}`, 2);
      return v;
    };
    if (x === "triggers" || x === "behavior" || x === "all") a.suite = x;
    else if (x === "--cases-file") a.casesFile = takeVal(x);
    else if (x.startsWith("--cases-file=")) a.casesFile = x.slice("--cases-file=".length);
    else if (x === "--cases") a.casesFilter = takeVal(x);
    else if (x.startsWith("--cases=")) a.casesFilter = x.slice("--cases=".length);
    else if (x === "--split") a.split = takeVal(x);
    else if (x.startsWith("--split=")) a.split = x.slice("--split=".length);
    else if (x === "--model") a.model = takeVal(x);
    else if (x.startsWith("--model=")) a.model = x.slice("--model=".length);
    else if (x === "--matrix") a.matrix = true;
    else if (x === "--runs") a.runs = parseInt(takeVal(x), 10);
    else if (x.startsWith("--runs=")) a.runs = parseInt(x.slice("--runs=".length), 10);
    else if (x === "--max-turns") a.maxTurns = parseInt(takeVal(x), 10);
    else if (x.startsWith("--max-turns=")) a.maxTurns = parseInt(x.slice("--max-turns=".length), 10);
    else if (x === "--keep-workspaces") a.keep = true;
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--out") a.out = takeVal(x);
    else if (x.startsWith("--out=")) a.out = x.slice("--out=".length);
    else if (x === "--label") a.label = takeVal(x);
    else if (x.startsWith("--label=")) a.label = x.slice("--label=".length);
    else if (x === "-h" || x === "--help") { console.log(USAGE); process.exit(0); }
    else die(`unrecognized argument: ${x}\n\n${USAGE}`, 2);
  }
  if (!a.suite) a.suite = "all";
  if (a.runs !== null && (!Number.isFinite(a.runs) || a.runs < 1)) die("--runs must be a positive integer", 2);
  if (a.maxTurns !== null && (!Number.isFinite(a.maxTurns) || a.maxTurns < 1)) die("--max-turns must be a positive integer", 2);
  if (a.split !== null && a.split !== "train" && a.split !== "validation") die('--split must be "train" or "validation"', 2);
  return a;
}

/* ========================================================================== *
 *  cases loading + validation
 * ========================================================================== */

// Resolve the cases file for a suite. Returns { path, exists }.
function casesFileFor(suite, explicit) {
  if (explicit) return { path: resolve(explicit), exists: existsSync(resolve(explicit)) };
  const p = join(HERE, "cases", `${suite}.json`);
  return { path: p, exists: existsSync(p) };
}

function loadCases(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (e) { die(`cannot read cases file ${path}: ${e.message}`); }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { die(`cases file ${path} is not valid JSON: ${e.message}`); }
  return doc;
}

// Validate a single trigger case against the FROZEN schema:
//   { id, query, expect_skill: "<name>"|null, split: "train"|"validation" }
function validateTrigger(c, i, path) {
  const where = `${basename(path)} triggers[${i}]`;
  if (!c || typeof c !== "object") die(`${where}: not an object`);
  if (typeof c.id !== "string" || !c.id) die(`${where}: missing string "id"`);
  if (typeof c.query !== "string" || !c.query) die(`${where} (${c.id}): missing string "query"`);
  if (!(c.expect_skill === null || (typeof c.expect_skill === "string" && OUR_SKILLS_SET.has(c.expect_skill))))
    die(`${where} (${c.id}): "expect_skill" must be null or one of ${OUR_SKILLS.join(", ")}`);
  if (c.split !== undefined && c.split !== "train" && c.split !== "validation")
    die(`${where} (${c.id}): "split" must be "train" or "validation"`);
}

// Validate a single behavior case against the FROZEN schema (+ optional
// `baseline` boolean, mandated by the runner spec for no-skill runs):
//   { id, skill, workspace, prompt_file, runs, assertions: [...] }
const ASSERTION_TYPES = new Set([
  "file-has-text", "file-absent-text", "render-clean", "check-clean",
  "tool-used", "tool-not-used", "reply-mentions",
]);
function validateBehavior(c, i, path) {
  const where = `${basename(path)} behavior[${i}]`;
  if (!c || typeof c !== "object") die(`${where}: not an object`);
  if (typeof c.id !== "string" || !c.id) die(`${where}: missing string "id"`);
  if (typeof c.skill !== "string" || !OUR_SKILLS_SET.has(c.skill))
    die(`${where} (${c.id}): "skill" must be one of ${OUR_SKILLS.join(", ")}`);
  if (typeof c.workspace !== "string" || !c.workspace) die(`${where} (${c.id}): missing string "workspace"`);
  if (typeof c.prompt_file !== "string" || !c.prompt_file) die(`${where} (${c.id}): missing string "prompt_file"`);
  if (c.runs !== undefined && (!Number.isInteger(c.runs) || c.runs < 1)) die(`${where} (${c.id}): "runs" must be a positive integer`);
  if (c.baseline !== undefined && typeof c.baseline !== "boolean") die(`${where} (${c.id}): "baseline" must be a boolean`);
  if (!Array.isArray(c.assertions) || c.assertions.length === 0) die(`${where} (${c.id}): "assertions" must be a non-empty array`);
  c.assertions.forEach((as, j) => {
    const w2 = `${where} (${c.id}) assertions[${j}]`;
    if (!as || typeof as.type !== "string") die(`${w2}: missing "type"`);
    if (!ASSERTION_TYPES.has(as.type)) die(`${w2}: unknown assertion type "${as.type}"`);
    if (["file-has-text", "file-absent-text", "render-clean", "check-clean"].includes(as.type) && typeof as.file !== "string")
      die(`${w2} (${as.type}): requires string "file"`);
    if (["file-has-text", "file-absent-text"].includes(as.type) && typeof as.text !== "string")
      die(`${w2} (${as.type}): requires string "text"`);
    if (["tool-used", "tool-not-used"].includes(as.type) && typeof as.tool !== "string")
      die(`${w2} (${as.type}): requires string "tool"`);
    if (as.type === "reply-mentions" && typeof as.text !== "string")
      die(`${w2} (reply-mentions): requires string "text"`);
  });
}

/* ========================================================================== *
 *  workspace + isolated-config setup (install.sh copy semantics)
 * ========================================================================== */

// Copy our three skills into <dest> exactly the way install.sh does:
//   present         → the whole skill dir (SKILL.md + references + renderer)
//   present-plan    → its own SKILL.md + a copy of present's renderer & references
//   present-recap   → same
function installSkills(destSkillsDir) {
  mkdirSync(destSkillsDir, { recursive: true });
  cpSync(join(SKILLS_SRC, "present"), join(destSkillsDir, "present"), { recursive: true });
  for (const s of ["present-plan", "present-recap"]) {
    const d = join(destSkillsDir, s);
    mkdirSync(d, { recursive: true });
    copyFileSync(join(SKILLS_SRC, s, "SKILL.md"), join(d, "SKILL.md"));
    cpSync(join(SKILLS_SRC, "present", "renderer"), join(d, "renderer"), { recursive: true });
    cpSync(join(SKILLS_SRC, "present", "references"), join(d, "references"), { recursive: true });
  }
}

// Build a throwaway CLAUDE_CONFIG_DIR with NO skills/ (so user-level skills do
// not load) but WITH the real credentials (so auth still works). Returns its
// path. Copied — never symlinked — so a token refresh in the child can never
// rewrite the real credentials file.
function setupIsolatedConfig() {
  const srcCfg = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const iso = mkdtempSync(join(tmpdir(), "skill-eval-cfg-"));
  let copiedCreds = false;
  for (const f of [".credentials.json", "settings.json"]) {
    const src = join(srcCfg, f);
    if (existsSync(src)) { try { copyFileSync(src, join(iso, f)); if (f === ".credentials.json") copiedCreds = true; } catch { /* best effort */ } }
  }
  if (!copiedCreds && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      `warning: no ${join(srcCfg, ".credentials.json")} to copy and no ANTHROPIC_API_KEY set — ` +
      `claude may fail to authenticate.`,
    );
  }
  return iso;
}

// Create a workspace for a case. `withSkills` false => baseline/no-skill run
// (empty .claude/skills/). `fixtureDir` (behavior only) is copied into the root,
// preserving any .git.
function setupWorkspace(withSkills, fixtureDir) {
  const ws = mkdtempSync(join(tmpdir(), "skill-eval-ws-"));
  const skillsDir = join(ws, ".claude", "skills");
  mkdirSync(skillsDir, { recursive: true });         // empty for baseline
  if (withSkills) installSkills(skillsDir);
  if (fixtureDir) {
    if (!existsSync(fixtureDir)) die(`fixture workspace not found: ${fixtureDir}`);
    cpSync(fixtureDir, ws, { recursive: true });     // dotfiles (.git) included
  }
  return ws;
}

// The FROZEN trigger schema carries no workspace/fixture, but a `present-recap`
// positive ("what changed on this branch?") is only realistic if the cwd is a
// git repo with a change WORTH recapping. The first live runs proved a toy
// one-file diff makes recap positives self-defeating: present-recap itself
// teaches "skip a tiny, single-file, obvious diff — plain git diff is faster",
// and both haiku and sonnet correctly followed that rule instead of firing.
// So the seed is a small multi-file service with an uncommitted change set
// spanning five files (~60 changed lines) — past the skill's own skip
// threshold. Harmless for `present` / `present-plan` triggers, which ignore it.
function seedTriggerGit(ws) {
  const git = (...args) => spawnSync("git", args, { cwd: ws, encoding: "utf8" });
  if (git("init", "-q").status !== 0) return; // git absent — skip silently
  git("config", "user.email", "eval@example.com");
  git("config", "user.name", "eval");
  git("config", "commit.gpgsign", "false");
  const mk = (p, c) => { mkdirSync(join(ws, dirname(p)), { recursive: true }); writeFileSync(join(ws, p), c, "utf8"); };
  mk("src/routes/users.js", 'import { store } from "../lib/store.js";\n\nexport function listUsers(req, res) {\n  return res.json(store.users);\n}\n');
  mk("src/routes/orders.js", 'import { store } from "../lib/store.js";\n\nexport function listOrders(req, res) {\n  return res.json(store.orders);\n}\n');
  mk("src/lib/store.js", "export const store = { users: [], orders: [] };\n");
  mk("src/lib/auth.js", "export function requireAuth(req) {\n  return Boolean(req.headers.authorization);\n}\n");
  mk("README.md", "# demo service\n\nA small service used for evaluation.\n");
  git("add", "-A"); git("commit", "-qm", "initial service scaffold");
  // Uncommitted multi-file working-tree change: auth guards + pagination on
  // both routes, a new validation module, store growth, README note.
  mk("src/routes/users.js", 'import { store } from "../lib/store.js";\nimport { requireAuth } from "../lib/auth.js";\nimport { validatePage } from "../lib/validate.js";\n\nexport function listUsers(req, res) {\n  if (!requireAuth(req)) return res.status(401).end();\n  const page = validatePage(req.query);\n  const size = Math.min(Number(req.query.size || 20), 100);\n  const start = (page - 1) * size;\n  return res.json({ page, size, items: store.users.slice(start, start + size) });\n}\n');
  mk("src/routes/orders.js", 'import { store } from "../lib/store.js";\nimport { requireAuth } from "../lib/auth.js";\n\nexport function listOrders(req, res) {\n  if (!requireAuth(req)) return res.status(401).end();\n  const { status } = req.query;\n  const items = status ? store.orders.filter((o) => o.status === status) : store.orders;\n  return res.json({ items, count: items.length });\n}\n');
  mk("src/lib/validate.js", 'export function validatePage(q) {\n  const page = Number(q.page || 1);\n  if (!Number.isInteger(page) || page < 1) throw new Error("bad page");\n  return page;\n}\n');
  mk("src/lib/store.js", "export const store = { users: [], orders: [], sessions: new Map() };\n\nexport function resetStore() {\n  store.users.length = 0;\n  store.orders.length = 0;\n  store.sessions.clear();\n}\n");
  mk("README.md", "# demo service\n\nA small service used for evaluation.\n\n## Changes in flight\n\nPagination, auth guards, and validation are being added across the routes.\n");
}

/* ========================================================================== *
 *  driving claude + stream-json parsing
 * ========================================================================== */

function assertClaudeOnPath() {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (r.error && r.error.code === "ENOENT")
    die("the `claude` CLI was not found on PATH. Install Claude Code and ensure `claude` is runnable.");
  if (r.status !== 0 && r.error)
    die(`could not run \`claude --version\`: ${r.error.message}`);
}

// Run one invocation. Returns the raw stdout (stream-json text) plus the child's
// exit status. Never throws on a non-zero exit — a capped (error_max_turns) run
// still yields a valid, parseable stream we want to grade.
function runClaude({ prompt, cwd, model, maxTurns, configDir }) {
  const args = [
    "-p", prompt,
    "--model", model,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", String(maxTurns),
    "--dangerously-skip-permissions",
  ];
  const r = spawnSync("claude", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      // Sandbox the browser opener: skills render with --open, and the opener
      // chain ($BROWSER → wslview → explorer.exe → xdg-open) would otherwise
      // pop every eval-rendered page onto the HUMAN's desktop mid-sweep.
      // `true` is a no-op binary: the opener "succeeds" silently and never
      // falls through to a real launcher.
      BROWSER: "true",
    },
  });
  if (r.error && r.error.code === "ENOENT")
    die("the `claude` CLI vanished from PATH mid-run.");
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}

// Parse stream-json into the three things graders need. `dumpPath` is where the
// raw text lives so a shape error can point at it. Fails LOUDLY (throws) when the
// hard-coded anchors are missing.
function parseStream(stdout, dumpPath) {
  const events = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (t[0] !== "{" && t[0] !== "[") continue;   // skip stray non-JSON banner lines
    try { events.push(JSON.parse(t)); } catch { /* tolerate a truncated tail line */ }
  }
  if (events.length === 0) throw shapeError("no JSON events parsed from the stream", dumpPath);

  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = events.find((e) => e.type === "result");
  if (!result) throw shapeError('no {type:"result"} event found', dumpPath);
  if (typeof result.total_cost_usd !== "number")
    throw shapeError('result event has no numeric "total_cost_usd"', dumpPath);

  // Collect tool_use blocks from assistant messages.
  const toolUses = [];        // { name, input, id }
  const skillsInvoked = [];   // skill names from name==="Skill" blocks
  for (const e of events) {
    if (e.type !== "assistant") continue;
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const b of content) {
      if (!b || b.type !== "tool_use") continue;
      toolUses.push({ name: b.name, input: b.input || {}, id: b.id });
      if (b.name === "Skill") {
        const s = b.input && b.input.skill;
        if (typeof s !== "string")
          throw shapeError('a Skill tool_use block has no string input.skill', dumpPath);
        skillsInvoked.push(s);
      }
    }
  }

  return {
    initSkills: init && Array.isArray(init.skills) ? init.skills : null,
    resultText: typeof result.result === "string" ? result.result : "",
    cost: result.total_cost_usd,
    subtype: result.subtype,
    isError: !!result.is_error,
    toolUses,
    skillsInvoked,
    ourSkillsInvoked: skillsInvoked.filter((s) => OUR_SKILLS_SET.has(s)),
  };
}

/* ========================================================================== *
 *  behavior assertion graders
 * ========================================================================== */

// Normalize a tool_use's path argument to a workspace-relative string (best
// effort). Edit/Write use file_path; NotebookEdit uses notebook_path; others may
// use path. Absolute paths inside the workspace are made relative.
function toolPathValue(tu) {
  const inp = tu.input || {};
  let p = inp.file_path || inp.path || inp.notebook_path || inp.filePath || null;
  return typeof p === "string" ? p : null;
}

function normRel(p, ws) {
  if (!p) return p;
  const abs = resolve(ws, p);
  const wsAbs = resolve(ws);
  return abs.startsWith(wsAbs + "/") ? abs.slice(wsAbs.length + 1) : p.replace(/^\.\//, "");
}

// Does a tool_use match {tool, path_prefix?} ? path_prefix is checked against the
// tool's path argument (Edit/Write/etc.); for Bash — which has no path arg — the
// prefix is matched as a substring of the command, so `tool-not-used Bash src/`
// still catches an `rm src/...`.
function toolMatches(tu, tool, pathPrefix, ws) {
  if (tu.name !== tool) return false;
  if (!pathPrefix) return true;
  const p = toolPathValue(tu);
  if (p != null) return normRel(p, ws).startsWith(pathPrefix);
  if (tu.name === "Bash" && typeof tu.input.command === "string")
    return tu.input.command.includes(pathPrefix);
  return false;
}

// Evaluate one assertion. Returns { ok, detail }.
async function evalAssertion(as, ws, parsed) {
  switch (as.type) {
    case "file-has-text": {
      const fp = join(ws, as.file);
      if (!existsSync(fp)) return { ok: false, detail: `${as.file} does not exist` };
      const txt = readFileSync(fp, "utf8");
      return { ok: txt.includes(as.text), detail: txt.includes(as.text) ? "" : `${as.file} lacks "${as.text}"` };
    }
    case "file-absent-text": {
      const fp = join(ws, as.file);
      if (!existsSync(fp)) return { ok: true, detail: `${as.file} absent (text trivially absent)` };
      const txt = readFileSync(fp, "utf8");
      return { ok: !txt.includes(as.text), detail: txt.includes(as.text) ? `${as.file} still contains "${as.text}"` : "" };
    }
    case "render-clean": {
      const fp = join(ws, as.file);
      if (!existsSync(fp)) return { ok: false, detail: `${as.file} does not exist` };
      let mod;
      try { mod = await import(pathToFileURL(RENDER_MJS).href); }
      catch (e) { return { ok: false, detail: `cannot import render.mjs: ${e.message}` }; }
      try {
        const src = readFileSync(fp, "utf8");
        const { warnings } = mod.renderPlan(src, { sourcePath: fp });
        return { ok: warnings.length === 0, detail: warnings.length ? `renderPlan warnings: ${warnings.join("; ")}` : "" };
      } catch (e) {
        return { ok: false, detail: `renderPlan threw: ${e.message}` };
      }
    }
    case "check-clean": {
      const fp = join(ws, as.file);
      if (!existsSync(fp)) return { ok: false, detail: `${as.file} does not exist` };
      const r = spawnSync("node", [CHECK_MJS, fp], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      if (r.status === 0) {
        const skipped = /check skipped/.test(out);
        return { ok: true, detail: skipped ? "check-clean: skipped (no browser)" : "" };
      }
      return { ok: false, detail: `check.mjs failed (exit ${r.status}): ${(r.stderr || out).trim().split("\n").slice(0, 3).join(" | ")}` };
    }
    case "tool-used": {
      const hit = parsed.toolUses.some((tu) => toolMatches(tu, as.tool, as.path_prefix, ws));
      return { ok: hit, detail: hit ? "" : `tool ${as.tool}${as.path_prefix ? " @" + as.path_prefix : ""} was never used` };
    }
    case "tool-not-used": {
      const hit = parsed.toolUses.some((tu) => toolMatches(tu, as.tool, as.path_prefix, ws));
      return { ok: !hit, detail: hit ? `tool ${as.tool}${as.path_prefix ? " @" + as.path_prefix : ""} was used` : "" };
    }
    case "reply-mentions": {
      const hit = parsed.resultText.toLowerCase().includes(as.text.toLowerCase());
      return { ok: hit, detail: hit ? "" : `reply did not mention "${as.text}"` };
    }
    default:
      return { ok: false, detail: `unimplemented assertion type ${as.type}` };
  }
}

/* ========================================================================== *
 *  running the suites
 * ========================================================================== */

const state = {
  dumpsDir: null,   // where raw stream-json is persisted for shape errors
  cleanupDirs: [],  // workspaces + config dirs to rm unless --keep-workspaces
  cost: 0,
};

let DUMP_SEQ = 0;
function persistDump(stdout) {
  mkdirSync(state.dumpsDir, { recursive: true });
  const p = join(state.dumpsDir, `stream-${Date.now()}-${DUMP_SEQ++}.jsonl`);
  writeFileSync(p, stdout, "utf8");
  return p;
}

// Run one invocation end-to-end: workspace, claude, parse. Returns the parsed
// result (and adds cost to the running total). Persists a dump on shape failure.
function invoke({ prompt, ws, model, maxTurns, configDir }) {
  const { stdout } = runClaude({ prompt, cwd: ws, model, maxTurns, configDir });
  let parsed;
  try {
    parsed = parseStream(stdout, "(pending dump)");
  } catch (e) {
    const dump = persistDump(stdout);
    // Re-raise with the real dump path.
    throw new Error(String(e.message).replace("(pending dump)", dump));
  }
  state.cost += parsed.cost;
  return parsed;
}

// ── triggers ─────────────────────────────────────────────────────────────────
async function runTriggerCase(c, opts) {
  const runs = opts.runs;
  const fires = [];   // per-run: did the EXPECTED behavior happen?
  process.stdout.write(`  ${c.id}  [${c.expect_skill === null ? "neg" : "→" + c.expect_skill}] `);
  for (let r = 0; r < runs; r++) {
    const ws = setupWorkspace(true, null);
    seedTriggerGit(ws);
    state.cleanupDirs.push(ws);
    const parsed = invoke({ prompt: c.query, ws, model: opts.model, maxTurns: opts.maxTurns, configDir: opts.configDir });
    if (!opts.keep) { rmSync(ws, { recursive: true, force: true }); state.cleanupDirs.pop(); }
    const ours = new Set(parsed.ourSkillsInvoked);
    let ok;
    if (c.expect_skill === null) ok = ours.size === 0;           // negative: nothing of ours should fire
    else ok = ours.has(c.expect_skill);                          // positive: the named skill fired
    fires.push(ok);
    process.stdout.write(ok ? "✓" : "✗");
  }
  const passCount = fires.filter(Boolean).length;
  const rate = passCount / runs;

  let verdict; // "pass" | "fail" | "warn"
  let notes;
  if (c.expect_skill === null) {
    // negative: a "fire" is a run where our skill DID fire (i.e. !ok here).
    const fireCount = runs - passCount;
    if (fireCount === 0) { verdict = "pass"; notes = "no stray firings"; }
    else if (fireCount / runs >= 2 / 3) { verdict = "fail"; notes = `fired on ${fireCount}/${runs} runs`; }
    else { verdict = "warn"; notes = `stray firing on ${fireCount}/${runs} runs`; }
  } else {
    if (rate >= 2 / 3) { verdict = "pass"; notes = `fired on ${passCount}/${runs} runs`; }
    else { verdict = "fail"; notes = `fired on only ${passCount}/${runs} runs`; }
  }
  process.stdout.write(`  ${verdict.toUpperCase()}  (${notes})  $${state.cost.toFixed(4)}\n`);
  return { id: c.id, kind: "trigger", rate, runs, verdict, notes, cost_usd: round(runCost()) };
}

// ── behavior ─────────────────────────────────────────────────────────────────
async function runBehaviorCase(c, opts, evalsRoot) {
  const runs = opts.runsExplicit ? opts.runs : (c.runs || DEFAULTS.behaviorRuns);
  const baseline = c.baseline === true;
  const fixtureDir = resolve(evalsRoot, c.workspace);
  const promptPath = join(fixtureDir, c.prompt_file);
  if (!existsSync(promptPath)) die(`behavior case ${c.id}: prompt_file not found: ${promptPath}`);
  const prompt = readFileSync(promptPath, "utf8");

  process.stdout.write(`  ${c.id}  [${baseline ? "baseline/no-skill" : c.skill}] `);
  let allPass = true;
  const runNotes = [];
  for (let r = 0; r < runs; r++) {
    const ws = setupWorkspace(!baseline, fixtureDir);
    state.cleanupDirs.push(ws);
    const parsed = invoke({ prompt, ws, model: opts.model, maxTurns: opts.maxTurns, configDir: opts.configDir });
    const failed = [];
    for (const as of c.assertions) {
      const { ok, detail } = await evalAssertion(as, ws, parsed);
      if (!ok) failed.push(detail || as.type);
      else if (detail) runNotes.push(detail); // e.g. "skipped (no browser)"
    }
    if (!opts.keep) { rmSync(ws, { recursive: true, force: true }); state.cleanupDirs.pop(); }
    const runOk = failed.length === 0;
    if (!runOk) { allPass = false; runNotes.push(...failed); }
    process.stdout.write(runOk ? "✓" : "✗");
  }
  const notes = runNotes.length ? [...new Set(runNotes)].join("; ") : "all assertions passed";
  // A baseline (no-skill) case exists to DEMONSTRATE the with/without delta —
  // its assertions failing is the expected, informative outcome. Record the
  // outcome but never count it in pass/fail totals.
  if (baseline) {
    process.stdout.write(`  BASELINE  (${allPass ? "assertions passed WITHOUT the skill — suspicious" : "delta demonstrated: " + notes})  $${state.cost.toFixed(4)}\n`);
    return { id: c.id, kind: "behavior", baseline: true, informational: true, assertions_passed_without_skill: allPass, runs, cost_usd: round(runCost()), notes };
  }
  process.stdout.write(`  ${allPass ? "PASS" : "FAIL"}  (${notes})  $${state.cost.toFixed(4)}\n`);
  return { id: c.id, kind: "behavior", passed: allPass, runs, cost_usd: round(runCost()), notes };
}

// Cost attributed to the current case = delta since the marker. We snapshot the
// running total before each case via `caseCostMark`.
let caseCostMark = 0;
function runCost() { const d = state.cost - caseCostMark; caseCostMark = state.cost; return d; }
function round(n) { return Math.round(n * 1e6) / 1e6; }

// Run one suite for one model. Returns { cases:[...], totals:{...} }.
async function runSuiteForModel(suite, cases, opts, evalsRoot) {
  console.log(`\n=== suite: ${suite}  model: ${opts.model}  runs/case: ${suite === "triggers" ? opts.runs : (opts.runsExplicit ? opts.runs : "case")}  max-turns: ${opts.maxTurns} ===`);
  const results = [];
  for (const c of cases) {
    caseCostMark = state.cost;
    if (suite === "triggers") results.push(await runTriggerCase(c, opts));
    else results.push(await runBehaviorCase(c, opts, evalsRoot));
  }
  const totals = { passed: 0, failed: 0, warned: 0, informational: 0, cost_usd: 0 };
  for (const r of results) {
    if (r.informational) { totals.informational++; totals.cost_usd += r.cost_usd; continue; }
    const v = r.kind === "trigger" ? r.verdict : (r.passed ? "pass" : "fail");
    if (v === "pass") totals.passed++;
    else if (v === "warn") totals.warned++;
    else totals.failed++;
    totals.cost_usd += r.cost_usd;
  }
  totals.cost_usd = round(totals.cost_usd);
  return { cases: results, totals };
}

/* ========================================================================== *
 *  dry-run
 * ========================================================================== */

function dryRun(plan) {
  console.log("DRY RUN — no models spawned, nothing spent.\n");
  for (const { suite, casesFile, cases, evalsRoot } of plan.suites) {
    console.log(`suite: ${suite}   cases file: ${casesFile}   (${cases.length} case(s))`);
    for (const c of cases) {
      if (suite === "triggers") {
        console.log(`  - ${c.id}  query=${JSON.stringify(c.query)}  expect=${c.expect_skill === null ? "null" : c.expect_skill}  split=${c.split || "-"}`);
      } else {
        const fixtureDir = resolve(evalsRoot, c.workspace);
        console.log(`  - ${c.id}  skill=${c.skill}  ws=${fixtureDir}  prompt=${c.prompt_file}  baseline=${c.baseline === true}  assertions=${c.assertions.map((a) => a.type).join(",")}`);
      }
    }
  }
  const models = plan.matrix ? ["haiku", "sonnet"] : [plan.model];
  console.log(`\nmodels: ${models.join(", ")}   triggers-runs: ${plan.runs.triggers}   behavior-runs: ${plan.runs.behavior}`);
  console.log(`results would be written to: ${plan.outPath}`);
}

/* ========================================================================== *
 *  main
 * ========================================================================== */

async function main() {
  const a = parseArgs(process.argv.slice(2));

  // Which suites to run.
  const suiteNames = a.suite === "all" ? ["triggers", "behavior"] : [a.suite];

  // Load + validate each suite's cases (tolerating an absent default file — a
  // sibling agent is still authoring cases/*.json).
  const loaded = [];
  for (const suite of suiteNames) {
    const { path, exists } = casesFileFor(suite, a.casesFile);
    if (!exists) {
      if (a.casesFile) die(`cases file not found: ${path}`);
      console.error(`note: no cases file at ${path} yet — skipping the ${suite} suite. ` +
        `(Pass --cases-file to point elsewhere.)`);
      continue;
    }
    const doc = loadCases(path);
    const evalsRoot = resolve(dirname(path), ".."); // <evals>/cases/x.json → <evals>
    let cases = Array.isArray(doc[suite]) ? doc[suite] : null;
    if (cases === null) die(`cases file ${path} has no "${suite}" array`);
    cases.forEach((c, i) => (suite === "triggers" ? validateTrigger : validateBehavior)(c, i, path));
    if (a.casesFilter) cases = cases.filter((c) => c.id.includes(a.casesFilter));
    if (a.split && suite === "triggers") cases = cases.filter((c) => c.split === a.split);
    if (cases.length === 0) {
      console.error(`note: ${suite}: no cases${a.casesFilter ? ` matching "${a.casesFilter}"` : ""} — skipping.`);
      continue;
    }
    loaded.push({ suite, casesFile: path, cases, evalsRoot });
  }
  if (loaded.length === 0) { console.error("nothing to run: no cases files found / matched."); process.exit(0); }

  // Resolve run counts + output path.
  const model = a.model || DEFAULTS.model;
  const runsTriggers = a.runs ?? DEFAULTS.triggerRuns;
  const runsBehavior = a.runs ?? DEFAULTS.behaviorRuns;
  const label = a.label || "run";
  const outPath = a.out ? resolve(a.out) : join(HERE, "results", `${today()}-${label}.json`);

  // Dry run: report and stop before spending anything.
  if (a.dryRun) {
    dryRun({ suites: loaded, matrix: a.matrix, model, runs: { triggers: runsTriggers, behavior: runsBehavior }, outPath });
    return;
  }

  assertClaudeOnPath();
  state.dumpsDir = join(dirname(outPath), "dumps");

  const configDir = setupIsolatedConfig();
  state.cleanupDirs.push(configDir);

  const models = a.matrix ? ["haiku", "sonnet"] : [model];
  const byModel = {};
  try {
    for (const m of models) {
      byModel[m] = {};
      for (const { suite, cases, evalsRoot } of loaded) {
        const opts = {
          model: m,
          runs: suite === "triggers" ? runsTriggers : runsBehavior,
          runsExplicit: a.runs != null,
          maxTurns: a.maxTurns ?? (suite === "triggers" ? DEFAULTS.triggerMaxTurns : DEFAULTS.behaviorMaxTurns),
          keep: a.keep,
          configDir,
        };
        byModel[m][suite] = await runSuiteForModel(suite, cases, opts, evalsRoot);
      }
    }
  } finally {
    if (!a.keep) {
      for (const d of state.cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    } else {
      console.log(`\n(kept workspaces + config dir: ${state.cleanupDirs.join(", ")})`);
    }
  }

  // Assemble the machine-readable results file.
  const out = assembleResults({ a, models, byModel, loaded });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");

  // Human summary.
  console.log("\n──────────── summary ────────────");
  printSummary(out);
  console.log(`\ntotal spend: $${state.cost.toFixed(4)}`);
  console.log(`results written: ${outPath}`);
}

// Shape the results object. Non-matrix: {date, model, suite, cases, totals}.
// Matrix: {date, models:[...], suites:[...], byModel:{<m>:{<suite>:{cases,totals}}}}.
function assembleResults({ a, models, byModel, loaded }) {
  const date = today();
  const suites = loaded.map((l) => l.suite);
  if (!a.matrix) {
    const m = models[0];
    // One model: flatten. If multiple suites ran, emit a `suites` map; if one,
    // emit the spec's {suite, cases, totals} directly.
    if (suites.length === 1) {
      const s = suites[0];
      return { date, model: m, suite: s, cases: byModel[m][s].cases, totals: byModel[m][s].totals };
    }
    const bySuite = {};
    let grand = { passed: 0, failed: 0, warned: 0, cost_usd: 0 };
    for (const s of suites) {
      bySuite[s] = byModel[m][s];
      grand.passed += bySuite[s].totals.passed;
      grand.failed += bySuite[s].totals.failed;
      grand.warned += bySuite[s].totals.warned;
      grand.cost_usd += bySuite[s].totals.cost_usd;
    }
    grand.cost_usd = round(grand.cost_usd);
    return { date, model: m, suites, bySuite, totals: grand };
  }
  // Matrix: keyed by model.
  const out = { date, models, suites, byModel: {} };
  for (const m of models) {
    out.byModel[m] = { suites: {}, totals: { passed: 0, failed: 0, warned: 0, cost_usd: 0 } };
    for (const s of suites) {
      out.byModel[m].suites[s] = byModel[m][s];
      out.byModel[m].totals.passed += byModel[m][s].totals.passed;
      out.byModel[m].totals.failed += byModel[m][s].totals.failed;
      out.byModel[m].totals.warned += byModel[m][s].totals.warned;
      out.byModel[m].totals.cost_usd += byModel[m][s].totals.cost_usd;
    }
    out.byModel[m].totals.cost_usd = round(out.byModel[m].totals.cost_usd);
  }
  return out;
}

function printSummary(out) {
  const line = (label, t) => console.log(`  ${label}: ${t.passed} passed, ${t.failed} failed, ${t.warned} warned  ($${t.cost_usd.toFixed(4)})`);
  if (out.byModel) {
    for (const m of out.models) line(`model ${m}`, out.byModel[m].totals);
  } else if (out.bySuite) {
    for (const s of out.suites) line(`${out.model} · ${s}`, out.bySuite[s].totals);
    line(`${out.model} · TOTAL`, out.totals);
  } else {
    line(`${out.model} · ${out.suite}`, out.totals);
  }
}

main().catch((e) => {
  // Loud failure path: surface the message (incl. any "CLI output shape changed"
  // dump path) and exit non-zero.
  console.error(`\nfatal: ${e.message}`);
  process.exit(1);
});
