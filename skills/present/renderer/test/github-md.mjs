#!/usr/bin/env node
// github-md.mjs (test) — zero-dependency tests for the --github emit
// (buildGithubMarkdown). Only node:assert — no npm install, no fixture files:
// one inline fixture string exercises every transformation rule.
//
// Run:  node skills/present/renderer/test/github-md.mjs

import assert from "node:assert/strict";

import { buildGithubMarkdown } from "../github-md.mjs";

let pass = 0, fail = 0;
function ok(name, fn) {
  try {
    fn();
    console.log("  PASS  " + name);
    pass++;
  } catch (e) {
    console.log("  FAIL  " + name + "\n        " + (e.message || e).split("\n").join("\n        "));
    fail++;
  }
}

/* ------------------------------------------------------------------------- *
 *  One fixture exercising every rule.
 * ------------------------------------------------------------------------- */

const FIXTURE = `---
title: "GitHub Emit Fixture"
objective: Exercise every transformation rule in one document.
status: proposed
---

Intro prose stays as prose. Inline \`code\` and **bold** untouched.

<!-- chapter: The design -->

\`\`\`diagram title="Upload flow" look=clean
flowchart LR
  U[User] --> A[upload action]
\`\`\`

\`\`\`wireframe surface=page title="Settings — after"
<div class="wf-toolbar"><span class="wf-title">Settings</span></div>
<div class="wf-row"><button class="wf-btn wf-primary">Save</button></div>
\`\`\`

\`\`\`callout tone=decision title="Push, don't fetch"
The uploader POSTs the file.
Second body line.
\`\`\`

\`\`\`callout tone=info
Untitled info body.
\`\`\`

\`\`\`callout tone=warning title="Careful"
Warn body.
\`\`\`

\`\`\`callout tone=risk title="Danger"
Risk body.
\`\`\`

\`\`\`steps
# Add a size guard
reuse src/lib/client.ts — uploadFile() already handles the PUT
edit src/actions/upload.ts — reject > 5MB
new src/actions/validate-size.ts
> Reuse the client; only the guard is new.
# Wire it in
delete src/legacy/old-upload.ts — removed
\`\`\`

\`\`\`filetree
. src/actions/
~   src/actions/upload.ts — guard added
+   src/actions/validate-size.ts — new
\`\`\`

\`\`\`data-model title="Billing schema"
+ plan
+   id uuid PK
user }o--|| plan : belongs to
\`\`\`

\`\`\`api-endpoint method=POST path=/v2/uploads title="Create upload"
+ query expires_in int — optional
request:
{ "name": "logo.png" }
response 201:
{ "id": "up_9f2" }
\`\`\`

\`\`\`code lang=ts file=src/actions/validate-size.ts hl=2
@note line=2: The only real logic.
export const MAX_BYTES = 5 * 1024 * 1024
export function isTooLarge(n) { return n > MAX_BYTES }
\`\`\`

\`\`\`diff file=src/actions/upload.ts mode=split
@@ -10,6 +10,9 @@ export default defineAction({
@note: The only behavioral change.
   run: async ({ file }) => {
+    if (file.size > MAX_BYTES) throw new ActionError('too large')
     return uploadFile(file)
\`\`\`

<!-- tabs:start -->
<!-- tab: Before -->

Old prose in the before tab.

<!-- tab: After -->

New prose in the after tab.

\`\`\`callout tone=info title="Nested in a tab"
Inner blocks still transform.
\`\`\`

<!-- tabs:end -->

<!-- collapsible: Verification details -->

Hidden prose here.

\`\`\`diagram
sequenceDiagram
  A->>B: ping
\`\`\`

<!-- collapsible:end -->

\`\`\`sequencediagram
Alice->Bob: raw body preserved
\`\`\`

A standard fence passes through:

\`\`\`js
console.log("untouched")
\`\`\`

\`\`\`questions
# Chunk uploads above 5MB?
default: No — single PUT until real usage appears.
# Per-user or per-org tokens?
default: Per-org.
\`\`\`
`;

const out = buildGithubMarkdown(FIXTURE);

console.log("\n# github-md fixture transforms");

/* --- frontmatter -------------------------------------------------------- */

ok("frontmatter -> # title + objective blockquote + **status:** line", () => {
  assert.match(out, /^# GitHub Emit Fixture\n/, "H1 title first");
  assert.match(out, /\n> Exercise every transformation rule in one document\.\n/, "objective as blockquote");
  assert.match(out, /\n\*\*status:\*\* proposed\n/, "status line");
  assert.ok(!out.includes("\n---\n"), "no leftover frontmatter delimiters");
  assert.ok(!/^title:/m.test(out), "no raw frontmatter keys");
});

ok("frontmatter is optional (no frontmatter -> body only)", () => {
  const o = buildGithubMarkdown("Just prose.\n");
  assert.equal(o, "Just prose.\n");
});

ok("partial frontmatter (title only) emits only the title line", () => {
  const o = buildGithubMarkdown("---\ntitle: Only Title\n---\n\nBody.\n");
  assert.match(o, /^# Only Title\n\nBody\.\n$/);
  assert.ok(!o.includes("**status:**"), "no status line when absent");
  assert.ok(!/^> /m.test(o), "no objective blockquote when absent");
});

/* --- diagram ------------------------------------------------------------ */

ok("diagram -> ```mermaid fence, body unchanged, attrs dropped, title bolded", () => {
  assert.match(out, /\*\*Upload flow\*\*\n```mermaid\nflowchart LR\n  U\[User\] --> A\[upload action\]\n```/);
  assert.ok(!out.includes("```diagram"), "no diagram fence survives");
  assert.ok(!out.includes("look=clean"), "our attrs are dropped");
});

ok("untitled diagram gets a bare mermaid fence (no bold line)", () => {
  assert.match(out, /```mermaid\nsequenceDiagram\n  A->>B: ping\n```/);
});

/* --- wireframe ---------------------------------------------------------- */

ok("wireframe -> placeholder line; raw HTML body never emitted", () => {
  assert.ok(out.includes("> 🖼 *wireframe: Settings — after* (interactive page only)"), "placeholder with title");
  assert.ok(!out.includes("wf-toolbar"), "no wireframe HTML classes");
  assert.ok(!out.includes("wf-btn"), "no wireframe button HTML");
  assert.ok(!out.includes("<div class="), "no raw div from the wireframe body");
});

ok("wireframe placeholder falls back to the surface when untitled", () => {
  const o = buildGithubMarkdown("```wireframe surface=panel\n<div class=\"wf-row\">x</div>\n```\n");
  assert.ok(o.includes("> 🖼 *wireframe: panel* (interactive page only)"));
  assert.ok(!o.includes("wf-row"));
});

/* --- callout -> GitHub alerts ------------------------------------------- */

ok("callout tones map to exact GitHub alert syntax", () => {
  assert.ok(out.includes("> [!IMPORTANT]\n> **Push, don't fetch**\n> The uploader POSTs the file.\n> Second body line."), "decision -> IMPORTANT + bold title + prefixed body");
  assert.ok(out.includes("> [!NOTE]\n> Untitled info body."), "info -> NOTE (untitled: no bold line)");
  assert.ok(out.includes("> [!WARNING]\n> **Careful**\n> Warn body."), "warning -> WARNING");
  assert.ok(out.includes("> [!CAUTION]\n> **Danger**\n> Risk body."), "risk -> CAUTION");
  assert.ok(!out.includes("```callout"), "no callout fence survives");
});

ok("unknown/missing callout tone defaults to NOTE", () => {
  const o = buildGithubMarkdown("```callout\nplain body\n```\n");
  assert.match(o, /^> \[!NOTE\]\n> plain body\n$/);
});

/* --- steps -------------------------------------------------------------- */

ok("steps -> numbered list with bold titles", () => {
  assert.match(out, /^1\. \*\*Add a size guard\*\*$/m);
  assert.match(out, /^2\. \*\*Wire it in\*\*$/m);
  assert.ok(!out.includes("```steps"), "no steps fence survives");
});

ok("step file lines -> - **verb** `path` — note", () => {
  assert.match(out, /^ {3}- \*\*reuse\*\* `src\/lib\/client\.ts` — uploadFile\(\) already handles the PUT$/m);
  assert.match(out, /^ {3}- \*\*edit\*\* `src\/actions\/upload\.ts` — reject > 5MB$/m);
  assert.match(out, /^ {3}- \*\*new\*\* `src\/actions\/validate-size\.ts`$/m, "no dangling — when note absent");
  assert.match(out, /^ {3}- \*\*delete\*\* `src\/legacy\/old-upload\.ts` — removed$/m);
});

ok("step rationale lines -> nested blockquote text", () => {
  assert.match(out, /^ {3}> Reuse the client; only the guard is new\.$/m);
});

/* --- filetree / data-model / api-endpoint -> text fences ----------------- */

ok("filetree -> body kept in a ```text fence", () => {
  assert.match(out, /```text\n\. src\/actions\/\n~ {3}src\/actions\/upload\.ts — guard added\n\+ {3}src\/actions\/validate-size\.ts — new\n```/);
  assert.ok(!out.includes("```filetree"), "no filetree fence survives");
});

ok("data-model -> bold title + ```text fence with the body verbatim", () => {
  assert.match(out, /\*\*Billing schema\*\*\n```text\n\+ plan\n\+ {3}id uuid PK\nuser }o--\|\| plan : belongs to\n```/);
  assert.ok(!out.includes("```data-model"), "no data-model fence survives");
});

ok("api-endpoint -> caption (title + method/path) + ```text fence", () => {
  assert.ok(out.includes("**Create upload** — `POST /v2/uploads`"), "title + method/path caption");
  assert.match(out, /```text\n\+ query expires_in int — optional\nrequest:\n\{ "name": "logo\.png" \}\nresponse 201:\n\{ "id": "up_9f2" \}\n```/);
  assert.ok(!out.includes("```api-endpoint"), "no api-endpoint fence survives");
});

/* --- code: @note extraction --------------------------------------------- */

ok("code -> ```<lang> fence; @note lines stripped and re-emitted after", () => {
  assert.match(out, /```ts\nexport const MAX_BYTES = 5 \* 1024 \* 1024\nexport function isTooLarge\(n\) \{ return n > MAX_BYTES \}\n```\n> \*\*line 2:\*\* The only real logic\./);
  assert.ok(!out.includes("@note line="), "no raw @note directive survives");
  assert.ok(!out.includes("```code"), "no code fence survives");
  assert.ok(!out.includes("hl=2"), "hl attr dropped");
});

/* --- diff: @note extraction ---------------------------------------------- */

ok("diff -> ```diff fence; @note: lines stripped and re-emitted as blockquotes", () => {
  assert.match(out, /```diff\n@@ -10,6 \+10,9 @@ export default defineAction\(\{\n {3}run: async \(\{ file \}\) => \{\n\+ {4}if \(file\.size > MAX_BYTES\) throw new ActionError\('too large'\)\n {5}return uploadFile\(file\)\n```\n> The only behavioral change\./);
  assert.ok(!out.includes("@note:"), "no raw @note: directive survives");
  assert.ok(!out.includes("mode=split"), "mode attr dropped");
});

/* --- questions ------------------------------------------------------------ */

ok("questions -> ### Open questions + bold q + _default:_ item", () => {
  assert.ok(out.includes("### Open questions"), "heading present");
  assert.match(out, /^- \*\*Chunk uploads above 5MB\?\*\*$/m);
  assert.match(out, /^ {2}- _default:_ No — single PUT until real usage appears\.$/m);
  assert.match(out, /^- \*\*Per-user or per-org tokens\?\*\*$/m);
  assert.match(out, /^ {2}- _default:_ Per-org\.$/m);
  assert.ok(!out.includes("```questions"), "no questions fence survives");
});

/* --- directives ----------------------------------------------------------- */

ok("chapter marker -> ## heading", () => {
  assert.match(out, /^## The design$/m);
  assert.ok(!out.includes("<!-- chapter:"), "no chapter comment survives");
});

ok("collapsible -> <details><summary>; inner content still transformed", () => {
  assert.ok(out.includes("<details>\n<summary>Verification details</summary>"), "details/summary emitted");
  assert.ok(out.includes("</details>"), "closing tag emitted");
  const inner = out.slice(out.indexOf("<details>"), out.indexOf("</details>"));
  assert.ok(inner.includes("Hidden prose here."), "inner prose kept");
  assert.ok(inner.includes("```mermaid"), "inner diagram transformed to mermaid");
  assert.ok(!out.includes("<!-- collapsible"), "no collapsible comments survive");
});

ok("tabs -> sequential bold-labeled sections; inner content transformed", () => {
  assert.match(out, /^\*\*Before\*\*$/m, "Before label bolded");
  assert.match(out, /^\*\*After\*\*$/m, "After label bolded");
  assert.ok(out.indexOf("**Before**") < out.indexOf("**After**"), "labels in order");
  assert.ok(out.includes("Old prose in the before tab."), "before content kept");
  assert.ok(out.includes("> [!NOTE]\n> **Nested in a tab**\n> Inner blocks still transform."), "callout inside a tab transformed");
  assert.ok(!out.includes("<!-- tabs:"), "no tabs comments survive");
  assert.ok(!out.includes("<!-- tab:"), "no tab comments survive");
});

/* --- unknown / standard fences --------------------------------------------- */

ok("unknown custom fence -> *(block: type)* label + ```text fence", () => {
  assert.ok(out.includes("*(block: sequencediagram)*\n```text\nAlice->Bob: raw body preserved\n```"), "labeled text fence");
  assert.ok(!out.includes("```sequencediagram"), "no unknown fence survives");
});

ok("standard language fences pass through untouched", () => {
  assert.ok(out.includes("```js\nconsole.log(\"untouched\")\n```"), "js fence verbatim");
});

ok("plain prose passes through untouched", () => {
  assert.ok(out.includes("Intro prose stays as prose. Inline `code` and **bold** untouched."));
  assert.ok(out.includes("A standard fence passes through:"));
});

/* --- output hygiene --------------------------------------------------------- */

ok("output carries no custom fence names or raw HTML wireframes at all", () => {
  for (const t of ["```steps", "```filetree", "```diff file=", "```code", "```diagram", "```wireframe", "```questions", "```callout", "```data-model", "```api-endpoint"]) {
    assert.ok(!out.includes(t), `no ${t} in output`);
  }
});

ok("no triple blank lines outside fences (tidy spacing)", () => {
  // Strip fenced bodies, then check spacing in what remains.
  const stripped = out.replace(/```[\s\S]*?```/g, "```<body>```");
  assert.ok(!/\n{4,}/.test(stripped), "no runs of 3+ blank lines");
});

/* --- size guard --------------------------------------------------------------- */

console.log("\n# size guard");

ok("small output is not truncated", () => {
  assert.ok(out.length < 60000, "fixture output under the soft limit");
  assert.ok(!out.includes("truncated"), "no truncation notice");
});

ok("oversized input truncates at a block boundary with the notice", () => {
  // Build a synthetic plan of many paragraphs + fenced blocks well over 60k.
  let big = "---\ntitle: Big\n---\n\n";
  for (let i = 0; i < 900; i++) {
    big += `Paragraph ${i} — ${"x".repeat(60)}\n\n`;
    big += "```diagram\nflowchart LR\n  A" + i + " --> B" + i + "\n```\n\n";
  }
  const o = buildGithubMarkdown(big);
  assert.ok(o.length <= 65536, `stays under GitHub's 65536 hard cap (got ${o.length})`);
  assert.ok(o.endsWith("*…truncated — see the full interactive page.*\n"), "truncation notice appended");
  // Block-boundary cut: every opened fence must be closed (even count of ``` lines).
  const fenceLines = o.split("\n").filter((l) => /^\s*```/.test(l));
  assert.equal(fenceLines.length % 2, 0, "no fence left open by the cut");
});

ok("truncated output still parses as balanced markdown near the cut", () => {
  let big = "---\ntitle: Big\n---\n\n";
  for (let i = 0; i < 3000; i++) big += `Line ${i} of filler prose that goes on for a while.\n\n`;
  const o = buildGithubMarkdown(big);
  assert.ok(o.length <= 65536);
  assert.ok(o.includes("truncated — see the full interactive page"));
  // The notice must be the very tail, after a blank line (block boundary).
  assert.match(o, /\n\n\*…truncated — see the full interactive page\.\*\n$/);
});

/* --- purity ------------------------------------------------------------------ */

console.log("\n# purity");

ok("buildGithubMarkdown is pure (same input -> same output; no throw on empty)", () => {
  assert.equal(buildGithubMarkdown(FIXTURE), out, "deterministic");
  assert.equal(typeof buildGithubMarkdown(""), "string");
  assert.equal(typeof buildGithubMarkdown(null), "string");
});

/* ------------------------------------------------------------------------- */

console.log("\n" + "─".repeat(60));
console.log(`Total: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("RESULT: FAIL");
  process.exit(1);
} else {
  console.log("RESULT: PASS");
}
