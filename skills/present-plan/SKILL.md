---
name: present-plan
description: Turn an implementation plan into a single self-contained, interactive HTML page you can review and approve locally — ordered steps, file trees, annotated diffs and code, Mermaid diagrams, wireframe mockups, callouts, chapters with a side nav, before/after tabs, and open questions you can answer inline. Builds on the `present` base skill for the general authoring, rendering, and feedback mechanics. Use when the user says "make a visual plan", "plan this visually", "show me a plan I can review/approve", "/present-plan" (or the older "/visual-plan" / "/presentation-plan"), or otherwise needs to SEE and sign off on a direction before code is written. Also use when the user pastes a blob starting `<!-- presentation-feedback v1 -->`: that's exported review feedback from a page you rendered earlier, not new prose — resolve it against `references/feedback.md`. Everything renders fully offline from file:// — no SaaS, no account, no server, no network at view time.
---

# Present: Plan

Builds on the `present` base skill — all of its authoring craft, block
catalog, render mechanics, and feedback round-trip apply here unchanged. The
installed copy of this skill is self-sufficient: the engine lives at
`<skill-dir>/renderer` and the reference catalog at `<skill-dir>/references`,
exactly as in `present`. This file adds only what's specific to planning.

## When to use it — and when to skip

Use it when the user needs to **see and approve a direction** before you
build: a multi-file feature, a refactor with hard-to-reverse choices, a UI
change worth mocking, anything where a wall of chat text would bury the
decision.

**Skip it** for truly trivial, low-risk work — a one-line fix, a rename, a
typo, a single obvious edit. Don't ceremony-wrap a change that needs no
approval; just do it. When in doubt about scope, a quick plan is cheap and the
page is the approval gate anyway.

For comprehension rather than approval — "explain this repo visually", "give
me a tour of how X works" — use the base `present` skill directly; that's not
this skill's job anymore.

## Planning discipline

Adapted from BuilderIO's MIT-licensed `BuilderIO/skills` (`visual-plan` /
`visual-recap`). We keep the planning rigor; the rendering is ours and 100%
local.

- **Research the real files first.** Read the actual code before planning.
  Cite concrete paths, functions, and types — never plan against an imagined
  codebase.
- **Lead with reuse.** For every step, name what it *reuses* before what it
  *adds*. The `steps` block has explicit `reuse` / `edit` / `new` / `delete`
  verbs for exactly this — most steps should start with `reuse`.
- **Decide hard-to-reverse bets first.** Wire formats, public IDs / routes,
  data shapes / schemas, and auth model are expensive to change later. Pin
  these early and make them prominent (a diagram, a `code` block, a
  `data-model`, a before/after tab). Easily-reversible details can stay at low
  resolution.
- **Keep examples at the right altitude.** Show the load-bearing snippet — the
  signature, the schema, the one behavioral diff — not whole files.
- **Planning is READ-ONLY.** Do not edit source, run migrations, or mutate
  state while planning. The only file you write is `plan.md` (and its
  rendered HTML).
- **One `questions` block at the bottom.** Collect every unresolved decision
  into a single block at the end, each with a recommended `default:` — don't
  scatter "TBD"s through the plan or block on them mid-flow.
- **The plan IS the approval gate.** Present the rendered page and ask for
  sign-off on *it*. Don't render a plan and then separately ask "does this
  look good?" — the page is the thing being approved.

## Workflow

1. **Research (read-only).** Explore the codebase and pin down the real
   files, types, and the hard-to-reverse bets. No source edits.
2. **Write `plan.md`** in the format documented in `references/format.md`:
   frontmatter (`title`, `objective`, `status`) plus prose interleaved with
   fenced blocks, and `<!-- chapter: Title -->` directives if the document is
   long enough to want a side nav.
3. **Render, then check:**
   ```
   node <skill-dir>/renderer/render.mjs plan.md --open
   node <skill-dir>/renderer/check.mjs <output.html>
   ```
   See the base skill for the cwd trap, `--lean`, and why you must always
   surface the printed `url:` / Windows path to the user.
4. **Present and request approval.** Give the user the printed `url:` /
   Windows path and a 2–3 line summary of the approach, and ask them to
   review the page and sign off. That review is the gate — proceed to
   implementation only after approval. Tell them, briefly, that the page
   itself takes feedback (note mode, questions, a verdict, Export).
5. **On a `presentation-feedback` paste**, work the ingestion algorithm in
   `<skill-dir>/references/feedback.md`: verify `doc`/`source`/docId still
   match `plan.md`, resolve each anchor, act on every note and answer in
   document order — fold each accepted-default/custom answer back into the
   plan body (the decision moves into the step/section it concerns, and the
   question drops out of the `questions` block) — never silently skip a note.
   Re-render, respond to each note explicitly, present v2.

## Optional: self-review before handoff

For a high-stakes plan (a hard-to-reverse bet, a wide blast radius), consider
spawning one skeptical subagent to audit the rendered plan **while the human
is reading it** — have it look for exactly the gaps the discipline above
exists to catch: missing reuse, a buried hard-to-reverse bet, thin rationale,
an unstated risk. Fold any real findings into the plan before, or while, the
user reviews. Skip this for routine plans — it's not free, and most plans
don't need it.
</content>
