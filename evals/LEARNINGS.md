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
