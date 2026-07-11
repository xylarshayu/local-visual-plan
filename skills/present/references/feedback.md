# `presentation-feedback v1` — the export/ingestion contract

This is the paste-back contract between the rendered page's **Export** button
and the agent reading what the user pastes. It's versioned (`v1`) so both
sides — `annotate.js`'s exporter and this file — evolve together instead of
silently drifting apart. Read this when a user pastes a blob starting
`<!-- presentation-feedback v1 -->` and you need to act on it, or when you're
asked to change what Export produces (don't, without bumping the version).

## 1. The grammar (normative — reproduce exactly)

```
<!-- presentation-feedback v1 -->
doc: <slug> (<docId>)
source: <absolute plan.md path or "unknown">
verdict: approve | request-changes | none

## checklist — <checked>/<total> checked
- [x] <item text> [<anchor>]
- [ ] <item text> [<anchor>]

## note — <kind> "<label>" [<anchor>]
> <excerpt ≤140 chars of the anchored element's text>
<the user's note text>

## answer — "<question label>" [<anchor>]
accepted default: <default text>        (or)        custom: <user text>

unreviewed questions: <n>               (only present when n > 0)
```

## 2. Field-by-field

- **`doc: <slug> (<docId>)`** — `<slug>` is the plan's kebab title (matches the
  `.visual-plans/<slug>/` directory convention). `<docId>` is `"pf-" +` the
  first 12 hex characters of `sha256(source)`, computed once at render time
  over the exact `plan.md` bytes that were rendered. Two renders of identical
  bytes get the same docId; edit one character and it changes — this is the
  "did the plan move under me" tripwire.
- **`source:`** — the absolute path to `plan.md` on the machine that rendered
  the page, or the literal string `unknown` if the page was rendered from
  stdin or later moved. You need this file to resolve anchors to lines.
- **`verdict:`** — one of `approve` / `request-changes` / `none`. `none` means
  the user exported without picking one (e.g. a partial review) — never read
  it as approval.
- **`## checklist — <checked>/<total> checked`** — present only when the plan
  has at least one GFM task-list item (`- [ ]` / `- [x]`). One `- [x]`/`- [ ]`
  line per task item, checked items first, each carrying its own `[<anchor>]`
  (kind `task`) so a checklist item can also be the target of a `## note`. The
  checked/unchecked state is whatever the reviewer's page currently shows —
  their own toggles if they clicked any boxes, else the plan's own authored
  `- [x]`/`- [ ]` for boxes they never touched. Nothing to fold back into
  `plan.md`: the source `- [ ]`/`- [x]` markers ARE the checklist; treat
  unchecked items still needing attention as the reviewer's real progress
  signal alongside their notes/verdict, not as something to "answer" like a
  question.
- **`## note — <kind> "<label>" [<anchor>]`** — one per pinned note, in
  document order. `<kind>` is one of `h p li task step file diff code diagram
  wireframe q callout chapter` (a hunk anchor looks like
  `diff:src-actions-upload-ts:h2`). `<label>` is the human-readable text the
  annotate UI showed next to the pin (a step title, a hunk's file+index, a
  heading's text) — informational, not authoritative; the anchor is. The `>`
  line is a ≤140-char excerpt of the anchored element's own text, present so
  the note is still resolvable even if the anchor drifts (§3.2). Everything
  after the excerpt, up to the next `##`, is the user's note verbatim.
- **`## answer — "<question label>" [<anchor>]`** — one per question the user
  interacted with (accepted the default, or wrote a custom answer). Untouched
  questions do **not** get an `## answer` block — see `unreviewed questions:`.
- **`accepted default: <text>`** vs **`custom: <text>`** — exactly one follows
  each `## answer` header. `accepted default:` echoes the plan's own
  `default:` text verbatim (so you don't have to re-open `plan.md` to know
  what was accepted); `custom:` is the user's own words.
- **`unreviewed questions: <n>`** — only emitted when `n > 0`; a count, not a
  list. It exists so "the user didn't get to all of it" is never mistaken for
  "the user accepted everything by default."
- Notes marked **note to self** in the composer never appear in this export —
  the grammar has no field for them. If a paste has zero `## note` blocks but
  the user says they left some, those were all self-notes; there is no hidden
  section to go looking for.

## 3. Ingestion algorithm

Run this whenever a message **begins with** `<!-- presentation-feedback v1 -->`
— treat it as structured input to process, not prose to summarize back.

### 3.1 Verify identity

1. Parse `doc:`, `source:`, `verdict:` from the header.
2. If `source:` is `unknown` or the path doesn't exist on disk, stop and ask
   the user for the current `plan.md` path — anchors can't resolve to lines
   without it, and excerpt-matching against nothing isn't matching.
3. Read `source:`. Compute `sha256` over its exact current bytes, take the
   first 12 hex characters, prefix `pf-`, compare to `<docId>`.
   - **Match** — the plan hasn't changed since render; anchors and line ranges
     (if you can get the anchor map, §3.2) are trustworthy as-is.
   - **Mismatch** — the plan moved under the review. Don't abort: say so once,
     up front ("plan.md changed since this was rendered — resolving notes by
     excerpt, not line numbers"), then fall through to excerpt matching (§3.2)
     for every note. Never silently treat a mismatch as a match.

### 3.2 Resolve each `[anchor]`

Preferred — **the anchor map**: if you still have the rendered HTML from this
session (you just produced it, or the user points you at it — default
location is `.visual-plans/<slug>/index.html` next to `source:`), parse its
`<script id="pf-anchor-map" type="application/json">` and look the anchor up
directly for `{kind, label, lines: [start, end]}`. Read exactly those 1-based
lines of `source:` for full context.

Fallback — **excerpt matching**: search `source:` for the `>` excerpt text.
Try, in order: (a) exact substring match; (b) whitespace-collapsed,
case-insensitive substring match (handles re-wrapped prose); (c) the anchor's
`label` as a substring match if the excerpt alone matches more than one place.
Use whichever succeeds first and take the surrounding paragraph/block as
context.

If neither pass finds a home for a note: **do not skip it**. Say explicitly,
by anchor and label, that you couldn't locate it in the current `plan.md`,
quote the excerpt back at the user, and ask where it belongs (or state your
best guess and flag it as a guess). A note that silently vanishes is worse
than a render that breaks loudly.

### 3.3 Act, note by note, in document order

For each resolved `## note`:

- If the plan is still pre-approval (a `presentation-plan` review), the note
  is almost always an edit to `plan.md` — change the step's approach, tighten
  a rationale, redirect a hard-to-reverse bet. Edit at the resolved lines.
- If the plan is already approved and you're mid-implementation (or this is a
  `presentation-recap` review of code that already exists), the note is
  usually an instruction to change the code — treat it like any other
  in-thread feedback and implement it against the resolved context.
- Either way, say what you did, tied to the note's anchor/label — "step
  `add-a-size-guard`: made the limit a config value (`MAX_UPLOAD_BYTES`) as
  asked" — so every note gets an explicit, visible answer. Never
  batch-acknowledge ("addressed your feedback") without naming which note maps
  to which change.

### 3.4 Fold answers back into the plan

For each `## answer`:

1. Resolve its `[anchor]` the same way as a note (§3.2) to find the matching
   `# <question>` entry in the plan's `questions` block.
2. Take the decided text — the `accepted default:` text verbatim, or the
   `custom:` text — and move it into the plan **body**: a new `>` rationale
   line under the relevant step, or a short prose sentence right after the
   section the question was about. This is what "the answer moves into the
   plan" means: it becomes part of the plan, not a note about the plan.
3. Remove that question's `# ` entry from the `questions` block entirely. A
   resolved question does not linger there re-asking something already decided.
4. Leave every question **not** named in an `## answer` untouched in the
   `questions` block — including the ones counted by `unreviewed questions:`.

### 3.5 Handle the verdict

- **`approve`** — after acting on every note/answer above, the plan is signed
  off: proceed to implementation (`presentation-plan`) or treat the change as
  accepted (`presentation-recap`).
- **`request-changes`** — after acting on every note/answer, re-render and
  present a new version for another pass (§3.6). Don't ask "does this look
  good now?" in chat — the re-rendered page is the next thing to review, same
  as the first round.
- **`none`** — informational only; don't infer approval or rejection. Say what
  you did with the notes/answers and ask what's next.

### 3.6 Re-render and respond

Re-run the renderer on the edited `plan.md` (the same command the skill always
uses: `node <skill-dir>/renderer/render.mjs <plan.md> --open`), surface the
printed `url:` / (WSL) `windows:` line same as any other render, and respond
to **every** note and answer explicitly — one line each, by anchor/label, is
enough. This is v2 of the review loop; if the user pins more notes on v2 and
exports again, the same algorithm applies fresh (the docId will differ because
the source changed — expected, not an error). Notes never re-anchor across
versions by design — that's why acting on all of them before re-rendering
matters.

## 4. Worked example

`plan.md` (excerpt):

````markdown
---
title: Add upload size guard
objective: Reject oversized uploads before they hit storage.
status: proposed
---

## Approach

```steps
# Add a size guard to the upload action
reuse src/lib/client.ts — uploadFile() already handles the PUT
edit src/actions/upload.ts — reject > 5MB before calling the client
new src/actions/validate-size.ts — pure size check, unit-tested
> Reuse the existing client; only the guard + validator are genuinely new.
```

```questions
# Chunk uploads above 5MB?
default: No — single PUT until real >5MB usage appears.
```
````

Pasted export:

```
<!-- presentation-feedback v1 -->
doc: add-upload-size-guard (pf-3f8a2c1d9e01)
source: /home/xylar/proj/.visual-plans/add-upload-size-guard/plan.md
verdict: request-changes

## note — step "Add a size guard to the upload action" [step:add-a-size-guard-to-the-upload-action]
> reuse src/lib/client.ts — uploadFile() already handles the PUT
Make the 5MB limit a config value, not a constant.

## answer — "Chunk uploads above 5MB?" [q:chunk-uploads-above-5mb]
accepted default: No — single PUT until real >5MB usage appears.
```

Resulting plan edit:

1. **docId check**: `sha256` of the current `plan.md` matches `pf-3f8a2c1d9e01`
   — safe to trust anchors/excerpts directly.
2. The note resolves (by anchor, or by excerpt if the map isn't handy) to the
   `steps` block's first step. Intent is a plan edit, not code (still
   `proposed`): add a `new` line for the config constant and tighten the
   rationale —
   ```
   new src/actions/validate-size.ts — pure size check, unit-tested; reads the
   limit from config (MAX_UPLOAD_BYTES), not a hardcoded constant
   > Reuse the existing client; the guard + validator + a config value are new.
   ```
3. The answer resolves to the `Chunk uploads above 5MB?` question. Its decided
   text (the accepted default) moves into the plan body — e.g. a line under
   the same step: `> Uploads stay a single PUT; no chunking until real >5MB
   usage shows up.` — and the question is deleted from the `questions` block
   (it was the only entry, so the block is now empty and can be dropped, or
   left in place empty if more questions get added later).
4. Response to the user: "step *Add a size guard*: made the limit a config
   value (`MAX_UPLOAD_BYTES`) as asked. Chunking question: kept your accepted
   default — single PUT, no chunking — and folded it into the plan; it's gone
   from the open-questions list." Then re-render and surface the new `url:`.
</content>
