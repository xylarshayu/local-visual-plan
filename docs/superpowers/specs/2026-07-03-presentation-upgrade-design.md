# Presentation Upgrade — Design

- **Date:** 2026-07-03
- **Status:** Approved
- **Owner:** Ayush Wardhan

## 1. Problem

The [2026-06-20 design](2026-06-20-local-visual-plan-design.md) explicitly
ruled this out as a non-goal:

> Comment threads anchored to elements; the agent ingesting inline comments.

That objection was never to the *feature* — it was to the fact that in
BuilderIO's version, a hosted SaaS is what carried the comment thread and did
the ingestion. Revisiting it now: the same feature, rebuilt with zero servers.
Notes live in the page and `localStorage`; the "backend" is the user's
clipboard. Nothing in the v1 "what stays sacred" list changes: one
self-contained `.html`, zero `npm install`, `plan.md` stays plain Markdown,
one engine with thin skills on top.

Alongside that flagship, this round also folds in: a callout block (the v1
`format.md` had left it out pending more block-catalog experience), chapters
with a side nav for documents long enough to want one, a real answer to
"explain a repo visually" (broadening `presentation-plan` rather than forking
a third skill), and two pieces of drift/hardening found while working on the
above — `visual-recap/SKILL.md` documented blocks (`data-model`,
`api-endpoint`, `file-tree`) the renderer never implemented, and a Mermaid
syntax error was discovered to ship silently with no validation.

## 2. Goals / Non-goals

### Goals

- Keep everything the v1 renderer did (steps / filetree / diff / code /
  diagram / wireframe / questions / tabs / collapsible), and add:
  - a `callout` block (`tone=info|decision|warning|risk`, markdown body).
  - chapters: `<!-- chapter: Title -->` directives → side nav + scrollspy,
    still one file; content before the first marker becomes an "Overview"
    chapter.
  - a stable, content-derived anchor on every addressable element, baked into
    the HTML alongside an anchor → source line-range map and the embedded
    plan source (§3.1).
  - an annotation layer: note mode, a review panel, interactive questions
    (Accept default / Answer differently), one overall verdict, Viewed
    checkboxes on recap diff tabs, `localStorage` persistence keyed
    `pf:<docId>`, and an Export producing `presentation-feedback v1` (§3.2).
  - a best-effort diagram validator (`check.mjs`) so a broken Mermaid diagram
    no longer ships silently.
  - secret redaction in `recap.mjs` at collection time.
- Rename `visual-plan` / `visual-recap` → `presentation-plan` /
  `presentation-recap` in place (one engine, one git history), with
  `install.sh` retiring the old names so the two generations can't
  double-trigger.
- Broaden `presentation-plan`'s discipline to cover explainer/tour documents,
  without adding new frontmatter surface.

### Non-goals (this round)

- Real-time multiplayer / co-editing (still ruled out, same as v1 — no server
  means no shared live session).
- Servers of any kind (the whole point, still).
- Text-selection anchoring — notes anchor at block/step/hunk/paragraph
  granularity; arbitrary range/quote-level anchoring (Hypothesis-style) is
  deferred until the simpler granularity proves insufficient.
- Cross-version note re-anchoring — notes are scoped to one `docId`
  (effectively one render of `plan.md`); re-attaching old notes to a
  re-rendered v2 is a later experiment. Export before re-rendering.
- Presenter mode — a full-screen, chapter-at-a-time view with `j`/`k` keys is
  a cheap follow-on once chapter structure exists, but isn't part of this
  round.

## 3. Two pinned contracts

These are the two "hard-to-reverse bets" of this round — public enough (an
export gets pasted into chat; an anchor gets cited by hand) that both are
versioned from day one.

### 3.1 The anchor scheme (normative)

Grammar: `<kind>:<slug>[:<n>]`. Kinds: `h p step file diff code diagram
wireframe q callout chapter`. A diff hunk's anchor extends its diff's anchor:
`<diff-anchor>:h<i>` (1-based hunk index).

- **Content-derived, not positional** — the slug comes from the element's
  salient text (kebab-cased), so a minor plan edit elsewhere in the document
  doesn't orphan an existing note. A `:2`-style numeric suffix disambiguates
  collisions.
- Carried on the element as both the `data-pf-anchor` attribute and the
  element `id` (so `#step:add-size-guard` is also a valid hand-typed deep
  link in chat).
- Two companions baked into every rendered page:
  - `<script id="pf-anchor-map" type="application/json">` — maps every anchor
    to `{kind, label, lines: [start, end] | null}`, 1-based line ranges into
    the source `plan.md`.
  - `<script id="pf-source">` — the base64-encoded `plan.md` source itself, so
    the page is self-describing (re-renderable, quotable) even without the
    original file on hand.
  - Plus, alongside the map: `docId` (`"pf-" +` the first 12 hex characters of
    `sha256(source)`) and the absolute source path — the pair that lets an
    ingesting agent confirm "this export still matches this plan.md."

### 3.2 `presentation-feedback v1` grammar (normative)

```
<!-- presentation-feedback v1 -->
doc: <slug> (<docId>)
source: <absolute plan.md path or "unknown">
verdict: approve | request-changes | none

## note — <kind> "<label>" [<anchor>]
> <excerpt ≤140 chars of the anchored element's text>
<the user's note text>

## answer — "<question label>" [<anchor>]
accepted default: <default text>        (or)        custom: <user text>

unreviewed questions: <n>               (only present when n > 0)
```

Markdown, not JSON — human-skimmable in the paste, trivial for an agent to
parse, and the excerpt line makes it robust even if an anchor's slug ever
drifts across an edit. Notes marked "note to self" in the composer are
excluded from the export entirely. The full annotated grammar and the
ingestion algorithm an agent runs against a pasted blob are the normative
content of `skills/presentation-plan/references/feedback.md` — this section
pins the wire format; that file pins the behavior on both sides.

## 4. Architecture deltas

Layered onto the v1 architecture (`skills/presentation-plan/renderer/`):

- **`render.mjs`** — each block renderer now emits `data-pf-anchor`/`id`;
  since `extractBlocks` already walks the source line-by-line, source line
  ranges for the anchor map are nearly free to compute alongside it. A new
  `transformChapters` pass splits on `<!-- chapter: Title -->` markers and
  builds the side-nav HTML (not supported inside `tabs`/`collapsible` — those
  directives don't compose with chapter markers). The `questions` block now
  renders as a form scaffold (default text + the two response affordances);
  `annotate.js` drives the interactive behavior. `docId` is computed once per
  render (`sha256` over the raw source) and embedded next to the base64
  source.
- **`annotate.js`** (new, vanilla JS, ~400 lines, inlined at assembly the same
  way `interactivity.js` is) — note-mode toggle and hover outline, a composer
  popover anchored to the clicked element, an audience toggle (for the agent /
  note to self), a review panel (all notes in document order + question
  answers + one verdict), Viewed checkboxes on recap diff tabs, persistence to
  `localStorage` under `pf:<docId>` with an in-memory fallback (Firefox's
  per-file `file://` origins block `localStorage`; Chrome shares one origin
  across *all* `file://` pages, which is exactly why the `pf:<docId>`
  namespace is mandatory, not cosmetic), and Export via
  `navigator.clipboard` (a `file://` page is a secure context, so this works)
  with a textarea-selection fallback, plus a Download-as-`.md` escape hatch
  via a Blob URL.
- **`styles.css` / `annotate.css`** — pins in the margin, the composer
  popover, the review panel, and print rules that hide the annotation layer
  entirely (notes are a screen-only concern).
- **`check.mjs`** (new) — `node check.mjs <rendered.html>` finds a local
  headless Chromium, loads the page, and asserts every `pre.mermaid` produced
  a sibling `<svg>`; failure output lists the captions of whichever diagrams
  didn't render. No browser found → exits clean (skip, not fail) — this stays
  best-effort forever, never a hard CI/install dependency. Motivating bug: a
  stray semicolon in a `sequenceDiagram` message shipped silently in a review
  before this existed.
- **`recap.mjs`** — redacts token-shaped strings (API keys, AWS-style keys,
  PEM headers, `Authorization:` header values) before hunks enter a `diff`
  block, at collection time — so masking happens once, upstream of both
  `recap.md` and the rendered HTML, rather than needing to be re-applied at
  each consumer.
- **`test/run.mjs`** — new fixtures/assertions for anchor stability across
  re-renders of unchanged content, chapter nav markers, source-map
  correctness, and export-shape.

## 5. Locked question answers

From the plan's open-questions block, each resolved with its default:

- **Skill names** — `presentation-plan` + `presentation-recap`.
  Verb-symmetric with `/presentation-plan` as the natural slash command;
  "planner" read as the agent, not the artifact.
- **Fork vs. rename** — rename in place. Git history is the archive; one
  engine stays one codebase; `install.sh` drops the old names so triggers
  don't double-fire.
- **Note granularity** — block/step/hunk/paragraph level. Covers pointed
  feedback without Hypothesis-style range-anchoring complexity; text
  selection can layer on later.
- **Presenter mode** — deferred. Chapters + nav land first; presenter mode is
  a small later add once that structure exists.
- **Cross-version re-anchoring** — no. Notes are per-version by `docId`;
  export before regenerating. Cross-version re-anchoring is a later
  experiment.
- **Explainer/tour docs** — broaden `presentation-plan` (no new frontmatter
  key — an explainer just omits `status` and leans on chapters/diagrams). A
  third skill only if explainer docs grow their own distinct workflow.
- **New block types** — add `callout` now (tiny renderer, high value for
  decisions/warnings); defer `data-model` / `api-endpoint` — a Mermaid
  `erDiagram` covers most schema needs until a real recap demands
  field-level change flags.

## 6. BuilderIO research notes

A read of BuilderIO's current skills plus their `agent-native` viewer repo,
done to steal conceptually — never code:

- **Their feedback loop is pull-based MCP**: the agent polls a
  `get-plan-feedback` tool against their hosted DB at prescribed moments.
  Ours is one clipboard paste — simpler, fully offline, and structurally
  can't silently miss a poll.
- **Both `BuilderIO/skills` repos are now confirmed MIT-licensed.** The
  [2026-06-20 design](2026-06-20-local-visual-plan-design.md)'s claim that the
  repo "ships no LICENSE file despite the 'open-source' label" is outdated as
  of this writing — worth noting here since that spec is still linked from
  the README as the original design record.
- **Ideas consciously borrowed** (conceptually, never their code):
  - *Note-to-self routing* — their comments carry a `resolutionTarget: agent |
    human`; we borrow the concept as a simple audience toggle (for the agent /
    note to self), with self-notes excluded from the export.
  - *Quote-based re-anchor evidence* — their comments store quoted text +
    context, and a comment whose anchor text vanished surfaces as a
    `detachedThread` instead of silently dropping. This validated our
    excerpt-in-export design (§3.2): the excerpt itself is the re-anchor
    evidence when a slug drifts.
  - *Secret redaction* — their recap masks `sk-•••`-style secrets before diff
    content enters a block; adopted directly in `recap.mjs`.
  - *A self-review pass* — for high-stakes plans, a skeptical reviewer
    sub-agent audits the published plan while the human reads it. Adopted as
    optional `presentation-plan` SKILL.md discipline, not a hard requirement.
  - Also noted but not adopted as-is: their question forms always auto-add a
    write-in option (matches our Accept-default/Answer-differently split —
    no change needed) and their recap skill's hard budgets (3–8 diff tabs,
    ~150 lines each) — ours already had comparable budgets (8 tabs / 220
    lines), kept unchanged.

## Addendum (2026-07-04) — three-skill restructure + data-model/api-endpoint

### Trigger

The first real `presentation-feedback v1` round-trip (this design's own
review page, exported and pasted back) argued the general presentation
capability was **trapped under a skill named `plan`**: "explain this repo
visually" and "teach me X as a page" have nothing to do with sign-off or
implementation steps, yet both lived inside `presentation-plan`'s frontmatter
and discipline. §5's answer to "explainer/tour docs" — broaden
`presentation-plan`, no new skill — was the wrong call once it shipped: a
plan-shaped skill that also claims to be a general explainer confuses
triggering, and reads oddly in its own discipline section (an approval gate
that sometimes isn't one).

### Resolution: a base skill + two thin adapters, not a fork, not a mega-skill

Three skills replace two. **`present`** is the new base: general authoring
craft, the full block catalog, render mechanics, and the feedback round-trip —
everything that isn't specific to a workflow. **`present-plan`** and
**`present-recap`** become genuinely thin adapters, each opening with "builds
on `present`" and adding only their own discipline (planning rigor;
diff-collection, grounding, and redaction rules, respectively).
`presentation-plan` / `presentation-recap` are retired the same way
`visual-plan` / `visual-recap` were before them — renamed in place, one
engine, one git history, no fork.

Rejected: one mega-skill covering plan + recap + explainer in a single
`SKILL.md`. Three reasons:

- **Per-trigger context economy.** A `SKILL.md` is always-on context once
  triggered. A user asking to "explain this repo" shouldn't load the
  planning discipline (research-first, lead-with-reuse, hard-to-reverse bets,
  the approval gate) or the recap-specific grounding/redaction rules — none of
  it is relevant to the ask, all of it is tokens spent for nothing.
- **Contradictory mode disciplines.** A plan's discipline ends at "the plan IS
  the approval gate — ask for sign-off." A recap's ends at "let them review;
  nothing about the diff leaves the machine" — no gate, no sign-off. An
  explainer ends at "invite exploration, there's no gate to pass." Folding
  three closing postures into one document either blurs all three or forces a
  pile of conditionals a reader has to disambiguate for themselves.
- **Crisper routing.** Three skills with non-overlapping trigger phrases route
  correctly at the moment of triggering, instead of routing internally — deep
  in one skill's prose, based on which sentence the user happened to say.

Each installed copy stays fully self-sufficient, per `install.sh`: `present`
carries the engine and references natively; `present-plan` and
`present-recap` each get their own copy, so no adapter ever depends on
`present` — or on each other — also being installed.

### New blocks: `data-model` and `api-endpoint`

§5 deferred both ("a Mermaid `erDiagram` covers most schema needs until a real
recap demands field-level change flags") — that real recap has now happened
enough times that the deferral is lifted. `format.md` carries the normative
grammar; the summary below is for orientation only.

- **`data-model`** — one block per entity: a name, then field lines each
  carrying a `filetree`-style change flag (`+ ~ - .`), a type, optional PK/FK
  badges, and an optional `was: <old value>` when the field changed. A
  trailing `relations:` section lists Mermaid-ER-style relation lines
  (`Entity ||--o{ Other : label`) as plain text, not a diagram — the point is
  reading a schema *diff*, which `erDiagram` has no notation for.
- **`api-endpoint`** — a `METHOD /path` header line, then flagged parameter
  lines (`path|query|header|body|auth`, each with its own change flag), then
  `request:` and one or more `response <code>:` sections whose JSON bodies
  render as zero-JS collapsible trees (`<details>`-based, no
  `interactivity.js` dependency).

Both get the same field-level anchoring every other block gets — a reviewer
pins a note on a single column or a single query param, not just the block as
a whole.

### `install.sh`

Now retires **two** prior name generations on every install
(`visual-plan`/`visual-recap` from before the 2026-07-03 rename, and
`presentation-plan`/`presentation-recap` from that rename itself) before
installing `present` / `present-plan` / `present-recap`, so none of the four
retired names can double-trigger alongside the current three.

## Addendum 2 (2026-07-04) — present-share: hosted links + instant tunnels

### Trigger

A rendered page is one self-contained HTML file. GitHub renders neither the
file nor our block syntax: raw URLs serve `text/plain` + `nosniff` (the
browser won't execute them as a page), and only ` ```mermaid ` fences get
native treatment in Markdown/PR comments — our diagrams are fenced
` ```diagram ` (Mermaid, hand-drawn look; there's no Excalidraw step to
clarify away, just a fence-name mismatch). A PR comment needs something
clickable, and a reviewer needs the full experience — anchors, notes,
chapters, tabs — not a degraded inline guess.

### Decision: push at render time, don't make a server fetch from GitHub

The share-service plan's "The decision" chapter has the call, and the three
costs it avoids by not having the VM fetch the HTML from GitHub instead:
committing the HTML to the repo first (megabytes per PR, or a `--lean`
compromise), standing GitHub credentials on the server (a GitHub App or
fine-grained PAT, refreshed, to read private org repos), and a fetch + cache
dance on every view with its own invalidation story. Pushing needs none of
it — the machine that already rendered the file POSTs it and gets a URL back;
the only credential anywhere is one upload token on the VM. The plan's
alternatives chapter keeps three other shapes on record (the fetch proxy
itself, a `gh-pages`-per-PR workflow, a lean-Markdown PR comment) without
changing the call.

### The contract

The plan's `api-endpoint` blocks are normative — `POST /p` (Bearer upload
token, raw `text/html` body, `ttl_days` query, 201 with `{id, url, docId,
title, expires_at}`) and `GET /p/:id` (the stored page, lock-down CSP, 404
when unknown or expired); this addendum only orients. The store is flat
files, shaped by the plan's `data-model` block: `manifest.json` plus one
`<id>.html` per share, a `token` row per uploader (a label plus a sha256
`secret_hash`, never plaintext), and a daily sweep deleting anything past its
TTL. `docId`/`title` are lifted from the page's own `pf-anchor-map` at upload
time — the store never needs telling what it received.

### Second mode: instant tunnels

The VM link is durable and VPN-scoped — right for a PR, wrong for "look at
this right now, over Teams, before any PR exists." That moment gets
`share.mjs <page> --tunnel`: serve the file locally, open a reverse tunnel
over plain `ssh` to a pinggy-style endpoint (credential-free on the free
tier), print the public URL. It wasn't in the original sketch — it arrived
via the **second** real `presentation-feedback v1` round-trip (review of this
plan's own rendered page), the same mechanism Addendum 1 credits for the
three-skill restructure, now improving a plan about presentation feedback via
presentation feedback. The two modes compose rather than compete: same verb,
`--tunnel` trading durability and VPN-scoping for zero setup.

### Security posture

Two postures for two links. The VM link's trust boundary is the upload
token — anyone holding it can publish arbitrary HTML at the VM's origin, so
it's hashed at rest, capped in size, viewed inside the existing VPN, and
rotated by editing one env var (or one `tokens.json` row). The CSP served on
every `GET /p/:id` — `default-src 'none'; script-src 'unsafe-inline';
style-src 'unsafe-inline'; img-src data:; font-src data:` — enforces the
offline promise server-side: inline everything, reach nothing, so even a
hostile wireframe body can't phone home from a reviewer's browser. It
contains what a page can do; it doesn't make hostile HTML safe to publish —
the token holder is trusted, same as a local author today. Tunnel mode widens
the boundary differently: the link is unguessable but public internet for its
lifetime, no VPN in front. `share.mjs` prints that warning on every `--tunnel`
run and refuses when the page's title matches `PRESENT_NO_TUNNEL_PATTERN` (a
user-configured regex for confidential markers) — though plans with real
secrets shouldn't exist in the first place; recap redaction runs before any
page does.

### The `--github` emit

A `--github` flag on `render.mjs` writes `github.md` next to `index.html`: a
degraded GitHub-flavored rendition where ` ```diagram ` fences become native
` ```mermaid ` ones, callouts become GitHub alert syntax, and wireframes
become placeholders — enough to preview inline in a PR comment or Markdown
file with zero clicks, complementary to the hosted link, not a replacement
for it.

### One approved deviation: `share.mjs` doesn't import `share/core.mjs`

The build plan's original shape has `skills/present/renderer/share.mjs`'s
`--tunnel` mode reuse `share/core.mjs` for its local mount. That doesn't
survive contact with `install.sh`: an installed skill dir
(`~/.claude/skills/present/renderer/`) carries `share.mjs` but not the
sibling `share/` directory it would need to import from — `present-plan` and
`present-recap` are self-sufficient specifically so neither depends on
`present` also being installed, and `share/` isn't installed at all (it's
server-side infra deployed separately, straight from this repo or a fork of
it). `share.mjs` ships self-contained instead: `--tunnel` mode inlines its own
tiny local file server rather than importing the shared core. Everything else
in the build plan is unchanged.

## Addendum 3 (2026-07-04) — the eval harness

### Trigger

The engine carries 192 deterministic tests (`skills/present/renderer/test/`,
`share/test/run.mjs`) gating every render/recap/share change. They test
nothing about the three `SKILL.md` files themselves: does "make a visual
plan" actually invoke `present-plan` and not `present`; does the agent, once
triggered, write a `plan.md` that leads with reuse and renders clean; does an
exported `presentation-feedback v1` blob land the right edit in the right
place. That's a second failure surface belonging to the prompt, not the
renderer — `.visual-plans/skill-evals/plan.md` (approved) designs the harness
for it; this addendum records the verdict and the shape that shipped.

### The research verdict

Three findings drove the design:

- **Anthropic's own position is "build your own harness."** Their [Agent
  Skills engineering
  post](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills):
  there is no built-in way to run these evaluations — evaluations are your
  source of truth. The runnable methodology lives at
  [agentskills.io](https://agentskills.io): labeled should/shouldn't-trigger
  query sets (~20 per skill, 3 runs each, a trigger-rate threshold) and
  with/without-skill output comparisons graded by assertions. There is no
  standardized cadence anywhere in the ecosystem — everyone runs evals
  locally, ad hoc; the Doctrine chapter of the plan (now `evals/README.md`)
  is this repo defining its own.
- **Nobody gates on live-model CI — including Anthropic.**
  [`anthropics/skills`](https://github.com/anthropics/skills) ships no CI at
  all for its skills. The one real precedent, `skill-creator`'s
  `run_eval.py` (3 runs per query, 60/40 train/test split, description
  proposals from failures), is a manually-run authoring tool, not a gate. A
  modest harness makes this repo more rigorous than the reference
  implementation.
- **[obra/superpowers](https://github.com/obra/superpowers)** supplies the
  missing third leg: RED-GREEN-REFACTOR for skill *rules* — pressure
  scenarios run against a fresh agent, failures documented verbatim, the
  skill edited to close each rationalization, re-tested until compliant.
  Their data point: 6 iterations to bulletproof one discipline rule.

### The three-suite design

One zero-dep runner (`evals/run.mjs`), three suites, per-case isolated
workspaces — each case runs `claude -p` inside a throwaway workspace whose
`.claude/skills/` contains exactly the three skills (populated by the same
copy logic as `install.sh`); baseline runs get an empty skills dir:

1. **Triggers** — ~60 labeled queries per skill: 8–10 positives
   (formal/casual/competing-skill phrasings) and 8–10 *strong* negatives —
   near-misses sharing keywords but wanting different behavior. Easy
   negatives test nothing.
2. **Authoring** — 2–3 scenarios per skill against tiny fixture projects,
   graded by `renderPlan()` warnings, `check.mjs`, and plain assertions. A
   with/without-skill baseline pair on one case gives the delta story the
   ecosystem measures (LangSmith reported 17%→92% on theirs).
3. **Ingestion + pressure** — feedback round-trips against seeded `plan.md` +
   export blobs (clean, unresolvable-anchor, docId-mismatch), plus 2–3
   superpowers-style pressure cases ("URGENT, skip the page, start coding")
   graded from `stream-json` tool-use events, not a judge.

### The grading advantage: the renderer is the grader

Every other harness in the survey pays an LLM judge to answer "is the output
right?" This one doesn't need to: a skill's output is `plan.md`/`recap.md` in
a strict, versioned grammar, so `renderPlan()`'s own warnings, `check.mjs`,
the anchor map, and plain string/tool-event assertions grade authoring and
ingestion correctness deterministically, for free. LLM judging is deferred
to the one thing code can't grade — altitude, prose taste — and v1 skips it
entirely; it's added later only if code-graded evals stop finding problems
first.

### The frozen case schema + pass criteria

Field names match agentskills.io (`expect_skill`, `split`, …) so cases stay
portable to other harnesses later. Pass criteria, pinned: a positive trigger
case passes at rate ≥ 2/3 over 3 runs; a negative fails the suite at a
stray-fire rate ≥ 2/3 (one stray firing in three is a warning, recorded, not
fatal). Behavior assertions are all-or-nothing per case. `split`
(`train`/`validation`) is honored only while tuning a description —
validation cases never choose one. Full schema, worked examples, and the
assertion-type catalog: `evals/README.md`.

### The model-matrix rationale

`--matrix` runs a suite across both haiku and sonnet — a call sharpened by
review feedback on the plan, not the original sketch, and it's exactly
right: **a heavy model can out-reason a weak skill** — brute intelligence
papers over a vague description or a mushy workflow, so a sonnet-only pass
rate can look clean while the skill itself is badly specified. **Haiku's
pass rate is the sensitive instrument for skill quality; sonnet's is the
fidelity check for what users actually run.** Baselines and pre-release
sweeps therefore run both, matching Anthropic's own checklist item to test
skills across model tiers.

### Portability

The skills already work beyond Claude Code — `install.sh` targets
`~/.agents/skills` for Cursor, Codex, Gemini CLI, OpenCode, and Copilot, and
`SKILL.md` is the cross-vendor open standard. The eval runner in v1 drives
`claude -p` only; the case schema is deliberately agent-neutral, so a
Quorum-style multi-CLI runner — evaling the same cases against `codex exec`
or another agent CLI — is a natural later extension of the schema, not a
rewrite.

### No-CI posture

Confirmed, not just proposed: cost anchors from the research (~$5.59 for a
250-invocation trigger study; behavior cases are multi-turn and cost more)
plus expected nondeterminism rule out a merge gate. `evals/run.mjs` is never
invoked by any CI config in this repo — manual at edit time per
`evals/README.md`'s doctrine, full sweep before tagging a release, same
posture as every surveyed repo including `anthropics/skills`. Committed
`evals/results/*.json` files carry the regression story across months
without re-running anything.

### Approval

`.visual-plans/skill-evals/plan.md` was approved via the **third** real
`presentation-feedback v1` round-trip — the same mechanism this document's
Addenda 1 and 2 credit for the three-skill restructure and `present-share`
respectively — verdict: approve. Notable this time: the feedback loop
reviewed a plan for evaluating the feedback loop's own skills, closing the
recursion once around.
