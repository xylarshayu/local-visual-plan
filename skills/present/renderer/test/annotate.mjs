/* Zero-dependency unit tests for annotate.js pure logic.

   Strategy: read annotate.js as text and evaluate it inside a vm context whose
   only globals are a `window` stub and `console`. Because there is no `document`
   in that context, the IIFE hits its DOM-boot guard and returns early, but not
   before attaching window.PFAnnotate. We then assert buildExportMarkdown emits
   the normative presentation-feedback v1 format byte-for-byte.

   Run:  node skills/presentation-plan/renderer/test/annotate.mjs   */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const annotatePath = join(here, "..", "annotate.js");
const code = readFileSync(annotatePath, "utf8");

/* Evaluate with a DOM-free shim; the IIFE must bail out of DOM setup and still
   expose the namespace. (No `document` global => boot guard trips.) */
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "annotate.js" });

const PF = sandbox.window.PFAnnotate;
assert.ok(PF, "window.PFAnnotate must be attached even without a DOM");
const { buildExportMarkdown, normalizeExcerpt, slugify, migrateState, verdictToken } = PF;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("  ok  " + name);
}

/* ---- shared fixtures --------------------------------------------------- */
const richMap = {
  version: 1,
  docId: "pf-abc123",
  source: "/home/you/project/.visual-plans/demo/plan.md",
  title: "Demo Plan Title",
  anchors: {
    "step:add-size-guard": { kind: "step", label: "Add a size guard", lines: [10, 14] },
    "diff:upload-ts": { kind: "diff", label: "upload.ts", lines: [20, 40] },
    "q:chunk-uploads": { kind: "q", label: "Chunk uploads above 5MB?", lines: null, default: "Chunk above 5MB by default." },
    "q:token-scope": { kind: "q", label: "Per-user or per-org tokens?", lines: null, default: "Per-org — matches the existing ownership model." },
    "q:untouched-one": { kind: "q", label: "Rename the flag?", lines: null, default: "Keep the current name." }
  }
};
const richOrder = ["step:add-size-guard", "diff:upload-ts", "q:chunk-uploads", "q:token-scope", "q:untouched-one"];

/* ---- 1. empty doc: header only ---------------------------------------- */
check("empty state -> header only, verdict none", () => {
  const emptyMap = { version: 1, docId: "pf-xyz", source: null, title: "Nothing Here", anchors: {} };
  const out = buildExportMarkdown(PF.defaultState(), emptyMap, []);
  const expected =
    "<!-- presentation-feedback v1 -->\n" +
    "doc: nothing-here (pf-xyz)\n" +
    "source: unknown\n" +
    "verdict: none\n";
  assert.equal(out, expected);
});

/* ---- 2. two agent notes + one self note (self excluded) --------------- */
check("agent notes exported in doc order, self note excluded", () => {
  const notesOnlyMap = {
    version: 1, docId: "pf-abc123", source: "/home/you/project/.visual-plans/demo/plan.md", title: "Demo Plan Title",
    anchors: {
      "step:add-size-guard": { kind: "step", label: "Add a size guard", lines: [10, 14] },
      "diff:upload-ts": { kind: "diff", label: "upload.ts", lines: [20, 40] }
    }
  };
  const notesOnlyOrder = ["step:add-size-guard", "diff:upload-ts"];
  const state = {
    version: 1,
    verdict: "approve",
    viewed: {},
    answers: {},
    notes: [
      { id: "a", anchor: "diff:upload-ts", excerpt: "const MAX = 5_000_000; if (file.size > MAX) throw new Error(\"too big\");", text: "This should be configurable per environment.", audience: "agent", ts: 2 },
      { id: "b", anchor: "step:add-size-guard", excerpt: "reuse src/lib/client.ts — uploadFile() already handles the PUT", text: "Make the 5MB limit a config value, not a constant.", audience: "agent", ts: 1 },
      { id: "c", anchor: "step:add-size-guard", excerpt: "reuse src/lib/client.ts", text: "remind myself to double-check this later", audience: "self", ts: 3 }
    ]
  };
  const out = buildExportMarkdown(state, notesOnlyMap, notesOnlyOrder);
  const expected =
    "<!-- presentation-feedback v1 -->\n" +
    "doc: demo-plan-title (pf-abc123)\n" +
    "source: /home/you/project/.visual-plans/demo/plan.md\n" +
    "verdict: approve\n" +
    "\n" +
    "## note — step \"Add a size guard\" [step:add-size-guard]\n" +
    "> reuse src/lib/client.ts — uploadFile() already handles the PUT\n" +
    "Make the 5MB limit a config value, not a constant.\n" +
    "\n" +
    "## note — diff \"upload.ts\" [diff:upload-ts]\n" +
    "> const MAX = 5_000_000; if (file.size > MAX) throw new Error(\"too big\");\n" +
    "This should be configurable per environment.\n";
  assert.equal(out, expected);
  assert.ok(!out.includes("remind myself"), "self note text must never appear");
});

/* ---- 3. THE MIXED CASE (pasted in the report) ------------------------- */
const mixedState = {
  version: 1,
  verdict: "request-changes",
  viewed: {},
  answers: {
    "q:chunk-uploads": { mode: "custom", text: "Yes, but only behind a flag." },
    "q:token-scope": { mode: "default", text: "" }
  },
  notes: [
    { id: "a", anchor: "step:add-size-guard", excerpt: "reuse src/lib/client.ts — uploadFile() already handles the PUT", text: "Make the 5MB limit a config value, not a constant.", audience: "agent", ts: 1 },
    { id: "b", anchor: "diff:upload-ts", excerpt: "const MAX = 5_000_000; if (file.size > MAX) throw new Error(\"too big\");", text: "This should be configurable per environment.", audience: "agent", ts: 2 },
    { id: "c", anchor: "diff:upload-ts", excerpt: "whatever", text: "check my own understanding here", audience: "self", ts: 3 }
  ]
};
const mixedExpected =
  "<!-- presentation-feedback v1 -->\n" +
  "doc: demo-plan-title (pf-abc123)\n" +
  "source: /home/you/project/.visual-plans/demo/plan.md\n" +
  "verdict: request-changes\n" +
  "\n" +
  "## note — step \"Add a size guard\" [step:add-size-guard]\n" +
  "> reuse src/lib/client.ts — uploadFile() already handles the PUT\n" +
  "Make the 5MB limit a config value, not a constant.\n" +
  "\n" +
  "## note — diff \"upload.ts\" [diff:upload-ts]\n" +
  "> const MAX = 5_000_000; if (file.size > MAX) throw new Error(\"too big\");\n" +
  "This should be configurable per environment.\n" +
  "\n" +
  "## answer — \"Chunk uploads above 5MB?\" [q:chunk-uploads]\n" +
  "custom: Yes, but only behind a flag.\n" +
  "\n" +
  "## answer — \"Per-user or per-org tokens?\" [q:token-scope]\n" +
  "accepted default: Per-org — matches the existing ownership model.\n" +
  "\n" +
  "unreviewed questions: 1\n";

check("mixed: custom + accepted-default answers + unreviewed count", () => {
  const out = buildExportMarkdown(mixedState, richMap, richOrder);
  assert.equal(out, mixedExpected);
});

/* ---- 4. verdict none + all questions untouched ------------------------ */
check("verdict none + all questions untouched -> unreviewed count only", () => {
  const state = { version: 1, verdict: null, viewed: {}, answers: {}, notes: [] };
  const out = buildExportMarkdown(state, richMap, richOrder);
  const expected =
    "<!-- presentation-feedback v1 -->\n" +
    "doc: demo-plan-title (pf-abc123)\n" +
    "source: /home/you/project/.visual-plans/demo/plan.md\n" +
    "verdict: none\n" +
    "\n" +
    "unreviewed questions: 3\n";
  assert.equal(out, expected);
});

/* ---- 5. detached note (anchor not in doc order) still exported -------- */
check("detached agent note still exported, sorted last", () => {
  const state = {
    version: 1, verdict: null, viewed: {}, answers: {},
    notes: [
      { id: "a", anchor: "step:add-size-guard", excerpt: "guard", text: "in-order note", audience: "agent", ts: 1 },
      { id: "z", anchor: "step:vanished-anchor", excerpt: "the text that was here", text: "detached note", audience: "agent", ts: 2 }
    ]
  };
  const out = buildExportMarkdown(state, richMap, richOrder);
  const iInOrder = out.indexOf("in-order note");
  const iDetached = out.indexOf("detached note");
  assert.ok(iInOrder > -1 && iDetached > -1, "both notes exported");
  assert.ok(iInOrder < iDetached, "detached note sorts after in-order note");
  assert.ok(out.includes("## note — step \"\" [step:vanished-anchor]"), "detached note uses prefix kind + empty label");
});

/* ---- 6. excerpt normalization ----------------------------------------- */
check("normalizeExcerpt collapses whitespace and truncates at 140 with ellipsis", () => {
  assert.equal(normalizeExcerpt("  a   b\n\tc  ", 140), "a b c");
  const long = "x".repeat(200);
  const out = normalizeExcerpt(long, 140);
  assert.equal(out.length, 141, "140 chars + ellipsis");
  assert.ok(out.endsWith("…"));
  assert.equal(normalizeExcerpt("x".repeat(140), 140), "x".repeat(140), "exactly 140 not truncated");
  assert.equal(normalizeExcerpt(null), "");
});

/* ---- 7. slugify + verdictToken ---------------------------------------- */
check("slugify + verdictToken", () => {
  assert.equal(slugify("From visual-plan to presentation!"), "from-visual-plan-to-presentation");
  assert.equal(slugify(""), "untitled");
  assert.equal(verdictToken("approve"), "approve");
  assert.equal(verdictToken("request-changes"), "request-changes");
  assert.equal(verdictToken(null), "none");
  assert.equal(verdictToken("garbage"), "none");
});

/* ---- 8. migrateState defaults / coercion ------------------------------ */
check("migrateState fills defaults and coerces bad shapes", () => {
  const d = migrateState(null);
  /* vm objects live in another realm, so compare structurally via JSON. */
  assert.equal(JSON.stringify(d), JSON.stringify({ version: 1, notes: [], answers: {}, verdict: null, viewed: {}, checks: {} }));
  const m = migrateState({
    notes: [{ anchor: "p:x", text: "hi" }, { text: "no anchor -> dropped" }],
    answers: { "q:a": { mode: "weird" }, "q:b": "not-object" },
    verdict: "bogus",
    viewed: { "diff:1": true, "diff:2": false },
    checks: { "task:a": true, "task:b": false, "task:c": "yes" }
  });
  assert.equal(m.notes.length, 1);
  assert.equal(m.notes[0].audience, "agent");
  assert.ok(typeof m.notes[0].id === "string" && m.notes[0].id.length > 0);
  assert.equal(m.answers["q:a"].mode, "default");
  assert.ok(!("q:b" in m.answers));
  assert.equal(m.verdict, null);
  assert.equal(JSON.stringify(m.viewed), JSON.stringify({ "diff:1": true }));
  /* checks keeps explicit false (unlike viewed, which only keeps truthy) —
     an unchecked override must survive a reload just as much as a checked
     one — and drops non-boolean garbage. */
  assert.equal(JSON.stringify(m.checks), JSON.stringify({ "task:a": true, "task:b": false }));
});

/* ---- 9. checklist export: stored override wins, default is the fallback -- */
check("checklist block: stored override wins over source default, unchecked stays unchecked", () => {
  const checklistMap = {
    version: 1, docId: "pf-abc123", source: "/home/you/project/.visual-plans/demo/plan.md", title: "Demo Plan Title",
    anchors: {
      "task:confirm-schema": { kind: "task", label: "Confirm schema reviewed", lines: null, default: false },
      "task:run-migration": { kind: "task", label: "Run the migration", lines: null, default: true },
      "task:smoke-test": { kind: "task", label: "Smoke test the endpoint", lines: null, default: false }
    }
  };
  const checklistOrder = ["task:confirm-schema", "task:run-migration", "task:smoke-test"];
  const state = {
    version: 1, verdict: null, viewed: {}, answers: {}, notes: [],
    checks: { "task:confirm-schema": true } // user ticked it; the other two never touched
  };
  const out = buildExportMarkdown(state, checklistMap, checklistOrder);
  const expected =
    "<!-- presentation-feedback v1 -->\n" +
    "doc: demo-plan-title (pf-abc123)\n" +
    "source: /home/you/project/.visual-plans/demo/plan.md\n" +
    "verdict: none\n" +
    "\n" +
    "## checklist — 2/3 checked\n" +
    "- [x] Confirm schema reviewed [task:confirm-schema]\n" +
    "- [x] Run the migration [task:run-migration]\n" +
    "- [ ] Smoke test the endpoint [task:smoke-test]\n";
  assert.equal(out, expected);
});

check("checklist block: a stored false overrides a source-authored true default", () => {
  const map = {
    version: 1, docId: "pf-def456", source: null, title: "Override Test",
    anchors: { "task:seed-data": { kind: "task", label: "Seed test data", lines: null, default: true } }
  };
  const order = ["task:seed-data"];
  const state = { version: 1, verdict: null, viewed: {}, answers: {}, notes: [], checks: { "task:seed-data": false } };
  const out = buildExportMarkdown(state, map, order);
  assert.ok(out.includes("## checklist — 0/1 checked"));
  assert.ok(out.includes("- [ ] Seed test data [task:seed-data]"));
  assert.ok(!out.includes("- [x] Seed test data"));
});

check("no task anchors -> no checklist block (docs without task lists are unaffected)", () => {
  const out = buildExportMarkdown(PF.defaultState(), richMap, richOrder);
  assert.ok(!out.includes("## checklist"), "richMap has no task-kind anchors; nothing to summarize");
});

console.log("\nannotate.js pure-logic tests: " + passed + " passed");
