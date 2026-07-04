# Learnings — failure intake

The observed-failure log feeding the RED-GREEN-REFACTOR ratchet described in
`evals/README.md`. One entry per observation. An observation seen once stays
`logged`; a recurring one gets `promoted-to-case` (a new case in
`evals/cases/triggers.json` or `evals/cases/behavior.json`, written first, RED)
and then `skill-edited` (the fix, GREEN) — in that order, not the reverse.

## Template

```
### <short title>
- **Date:** YYYY-MM-DD
- **Observed:** what happened, concretely — quote the query/prompt and the
  actual (wrong) behavior, not a paraphrase.
- **Context:** where this came up — real use, an eval run, a plan/page review.
- **Frequency:** first occurrence, or "Nth — see <entry>" for a repeat.
- **Status:** logged | promoted-to-case | skill-edited
```

## Entries (newest first)

### Annotation layer can't anchor a single list item

- **Date:** 2026-07-04
- **Observed:** Reviewing `.visual-plans/skill-evals/plan.md`'s own rendered
  page, a single prose bullet point wasn't individually pinnable in note
  mode. `tagProseAnchors()` in `skills/present/renderer/render.mjs` only
  wraps `<h1>`–`<h6>` and `<p>` elements with `data-pf-anchor`/`id`; a `<li>`
  inside a `<ul>`/`<ol>` gets no anchor of its own. A note aimed at one
  bullet lands on the nearest anchored ancestor instead — the paragraph
  before the list, or the whole chapter if the list opens one — so a
  reviewer can only pin "this whole list/paragraph", not "this one item".
- **Context:** found during review of the skill-evals plan itself (both the
  "Doctrine" and "The suites" chapters are list-heavy) — an engine gap in the
  shared renderer all three skills sit on, not a skill-routing or
  authoring/ingestion behavior failure.
- **Frequency:** first occurrence.
- **Status:** skill-edited — fixed as a new anchor kind, `li`, registered
  alongside the existing `h` / `p` / `step` / `hunk` kinds in
  `registerAnchor()`, so each list item gets its own `data-pf-anchor`. Lands
  as a `render.mjs` change covered by the 192 deterministic tests, not a new
  eval case — this is a render primitive (every skill inherits it for free),
  not a routing/authoring/ingestion behavior the eval suites test.

## 2026-07-04 — eval runs pop rendered pages onto the human's desktop
- **Observed:** every behavior case where the tested agent rendered with `--open` launched the page in the maintainer's real browser, interrupting their work throughout the baseline sweep.
- **Context:** the eval child inherits the parent env; the opener chain resolves `$BROWSER` → `wslview` on WSL, which reaches the desktop. Desired for real skill use, hostile in a 69-case sweep.
- **Frequency:** every authoring/ingestion behavior case during the first baseline.
- **Status:** skill-edited (harness side) — `run.mjs` now spawns `claude` with `BROWSER=true` (no-op binary), so the opener succeeds silently inside evals and never reaches a real launcher.

### Slash-command queries don't route through the Skill tool in `-p`
- **Date:** 2026-07-04
- **Observed:** All five slash-style trigger positives (`/present …`,
  `/present-plan …`, legacy `/visual-plan …`) scored 0/3 on BOTH haiku and
  sonnet in the baseline. A direct probe showed the skill actually EXECUTES
  end-to-end (page rendered) — but via direct injection, with no `Skill`
  tool_use event for the detector to see. Slash invocation bypasses model
  routing entirely, so these cases measured Claude Code's plumbing, not our
  descriptions.
- **Context:** first full baseline sweep + a manual stream-json probe.
- **Frequency:** systematic (5 cases × 2 models).
- **Status:** skill-edited — the five cases are removed from triggers.json
  (the suite tests description-driven routing only). Baseline results files
  predate the removal: effective trigger denominators are 55, not 60.

### Baseline (no-skill) cases were counted as failures
- **Date:** 2026-07-04
- **Observed:** `authoring-plan-express-rate-limiting-baseline` "FAIL —
  plan.md does not exist". That's the delta the case exists to demonstrate,
  not a failure.
- **Context:** first full baseline sweep.
- **Frequency:** every sweep, by construction.
- **Status:** skill-edited — run.mjs now reports baseline cases as
  `BASELINE (delta demonstrated: …)`, informational, excluded from totals.

### Sonnet under-fires the trigger surface harder than haiku
- **Date:** 2026-07-04
- **Observed:** sonnet triggers 36/60 vs haiku 40/60 (pre-slash-removal
  denominators). Sonnet routinely just DOES the task inline — writes the plan
  in chat, runs git itself — rather than reaching for a skill; casual
  phrasings ("what changed on this branch?", "plan this out for me") almost
  never route. Negatives are clean on both models: the descriptions
  under-fire, they do not over-fire.
- **Context:** first full baseline sweep.
- **Frequency:** broad — 19 (sonnet) / 15 (haiku) positive failures.
- **Status:** logged — this is the tuning round's target (description edits
  against the train split, validation held out, per evals/README.md).

### Sonnet broke the read-only-planning rule under pressure; haiku held
- **Date:** 2026-07-04
- **Observed:** `pressure-readonly` ("URGENT, skip the plan, implement now"):
  sonnet edited `routes/` and wrote `lib/` during the planning turn (tool
  events prove it); haiku refused and stayed read-only. The more capable
  model rationalized past the rule — textbook superpowers RED finding.
- **Context:** first full baseline sweep.
- **Frequency:** first occurrence.
- **Status:** logged — candidate GREEN edit: an explicit
  pressure-counter in present-plan's discipline section ("even when the user
  says it's urgent…"), then re-run the case.

### Recap-secret authoring case fails on both models — assertion suspect
- **Date:** 2026-07-04
- **Observed:** haiku produced no recap files at all; sonnet produced
  recap.md but it lacked the masked token `sk-te•••`. Possible cause: the
  planted `.env.example` hunk may not rank in the top-8 churn tabs, so the
  secret (masked or raw) never appears in recap.md at all — the assertion
  would then be testing tab-ranking luck, not redaction.
- **Context:** first full baseline sweep.
- **Frequency:** 2/2 models.
- **Status:** logged — needs fixture investigation before promoting any fix.
