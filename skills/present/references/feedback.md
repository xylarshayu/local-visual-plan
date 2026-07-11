# `presentation-feedback v2` — the export/ingestion contract

This is the paste-back contract between the rendered page's **Export** button
and the agent reading what the user pastes. It's versioned (`v2`) so both
sides — `annotate.js`'s exporter and this file — evolve together instead of
silently drifting apart. Read this when a user pastes a blob starting
`<!-- presentation-feedback` and you need to act on it, or when you're asked
to change what Export produces (don't, without bumping the version).

## 1. The grammar (normative — reproduce exactly)

```
<!-- presentation-feedback v2 -->
doc: <slug> (<docId>)
source: <absolute plan.md path or "unknown">

## checklist — <checked>/<total> checked
- [x] <item text> [<anchor>]
- [ ] <item text> [<anchor>]

## note — <kind> "<label>" [<anchor>]
> <excerpt ≤140 chars of the anchored element's text>
<the user's note text>

## answer — "<question label>" [<anchor>]
accepted default: <default text>        (or)        custom: <user text>
```

### Changes from v1

- **`verdict:` is gone.** v1 carried an approve / request-changes / none
  tri-state; it was ceremony, not signal. What to do next comes from the
  notes/answers themselves and from what the user says in chat.
- **`unreviewed questions: <n>` is gone, and every question now exports an
  `## answer`.** The question form pre-selects the default, so leaving it
  untouched IS accepting the default — v1 calling that "unreviewed" misread
  the user's intent. In v2, `accepted default:` covers both the explicit
  click and the left-in-place default; there is no third state.
- A paste starting `<!-- presentation-feedback v1 -->` comes from a page
  rendered before this change. Ingest it with this same algorithm, plus:
  treat its `verdict:` line as informational chat-level signal only, and
  treat questions it counts as "unreviewed" exactly like v2 accepted
  defaults unless the user says otherwise.

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
- **`## checklist — <checked>/<total> checked`** — present only when the plan
  has at least one GFM task-list item (`- [ ]` / `- [x]`). One `- [x]`/`- [ ]`
  line per task item, checked items first, each carrying its own `[<anchor>]`
  (kind `task`) so a checklist item can also be the target of a `## note`. The
  checked/unchecked state is whatever the reviewer's page currently shows —
  their own toggles if they clicked any boxes, else the plan's own authored
  `- [x]`/`- [ ]` for boxes they never touched. Nothing to fold back into
  `plan.md`: the source `- [ ]`/`- [x]` markers ARE the checklist; treat
  unchecked items still needing attention as the reviewer's real progress
  signal alongside their notes, not as something to "answer" like a question.
- **`## note — <kind> "<label>" [<anchor>]`** — one per pinned note, in
  document order. `<kind>` is one of `h p li task step file diff hunk code pre
  diagram wireframe q callout chapter table row cell data-model entity field
  relation api-endpoint param request response` (a hunk anchor looks like
  `diff:src-actions-upload-ts:h2`; a table cell like
  `table:option-cost:rewrite:cost`). `<label>` is the human-readable text the
  annotate UI showed next to the pin (a step title, a hunk's file+index, a
  cell's column+value) — informational, not authoritative; the anchor is. The
  `>` line is a ≤140-char excerpt of the anchored element's own text — or, for
  a note pinned on a **text selection** inside the element, the exact selected
  text (a substring of it) — present so the note is still resolvable even if
  the anchor drifts (§3.2; the algorithm is unchanged, and a selection excerpt
  just matches more precisely). Everything after the excerpt, up to the next
  `##`, is the user's note verbatim.
- **`## answer — "<question label>" [<anchor>]`** — exactly one per question
  in the plan, in document order.
- **`accepted default: <text>`** vs **`custom: <text>`** — exactly one follows
  each `## answer` header. `accepted default:` echoes the plan's own
  `default:` text verbatim (so you don't have to re-open `plan.md` to know
  what was accepted) and covers both an explicit "Accept default" click and a
  question the reviewer simply left on its pre-selected default; `custom:` is
  the user's own words.
- Notes marked **note to self** in the composer never appear in this export —
  the grammar has no field for them. If a paste has zero `## note` blocks but
  the user says they left some, those were all self-notes; there is no hidden
  section to go looking for.

## 3. Ingestion algorithm

Run this whenever a message **begins with** `<!-- presentation-feedback` —
treat it as structured input to process, not prose to summarize back. A
feedback paste is a request to update the plan: act on it, fold it in,
re-render, and hand back the new version.

### 3.1 Verify identity

1. Parse `doc:` and `source:` from the header.
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
lines of `source:` for full context. (Anchors with `lines: null` — prose
paragraphs, list items, table cells — resolve by excerpt instead.)

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

Every question gets an answer in v2, so a fully-worked paste normally leaves
the `questions` block empty (drop it, or leave it empty for the next round's
questions). If the user says in chat that they haven't really looked at some
question, honor that over the export — put it back / leave it open.

### 3.5 Re-render and respond

Re-run the renderer on the edited `plan.md` (the same command the skill always
uses: `node <skill-dir>/renderer/render.mjs <plan.md> --open`). Because the
previous render still sits at the output path, the renderer automatically
diffs the new version against it and **highlights what changed** — edited and
new elements get a marker bar, and the page shows a floating changes
navigator (‹ n/m › — also the `n`/`p` keys) plus a "Changed in this version"
list in the review panel, so the reviewer can walk exactly what moved instead
of re-reading the whole plan. The renderer prints a
`changes: <e> edited, <n> new, <r> removed` line — surface it, along with the
printed `url:` / (WSL) `windows:` line, same as any other render. (Pass
`--fresh` to suppress the highlights; pass `--prev <old plan.md or old
index.html>` to diff against something other than the overwritten page.)

Deliver your per-note responses **on the page too**: write a replies file
next to the plan — the convention is `.visual-plans/<slug>/replies.json` —
with one entry per `## note`, and pass it to that same re-render as
`--replies <file>`:

```
{"replies":[{"anchor":"step:add-a-size-guard-to-the-upload-action",
             "note":"Make the 5MB limit a config value",
             "reply":"Done — the limit now reads MAX_UPLOAD_BYTES from config"}]}
```

`anchor` is copied **verbatim** from the paste's `[<anchor>]`; `note` is a
short quote of the user's note; `reply` is what you did. The page renders each
reply as an inline card right at the anchored element (a table-cell anchor's
card surfaces after the enclosing table) plus an "Agent replies" list in the
review panel; a reply whose anchor no longer resolves still appears in the
panel list, marked unresolved.

Respond to **every** note and answer explicitly in chat as well — one line
each, by anchor/label, is enough; the reply cards supplement the chat
response, never replace it. This is v2 of the review loop; if the user pins more
notes on the new page and exports again, the same algorithm applies fresh
(the docId will differ because the source changed — expected, not an error).
Notes never re-anchor across versions by design — that's why acting on all of
them before re-rendering matters.

Whether to proceed to implementation after the round-trip is a chat-level
decision: the user saying "looks good, go" (in chat, or in a note) is the
gate. Absent that, present the updated page and wait.

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
<!-- presentation-feedback v2 -->
doc: add-upload-size-guard (pf-3f8a2c1d9e01)
source: /home/xylar/proj/.visual-plans/add-upload-size-guard/plan.md

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
   from the open-questions list." Then re-render (the changed step and its new
   file line come up highlighted, with the changes navigator pointing at
   them), surface the printed `changes:` and `url:` lines, and wait for the
   user's go-ahead in chat.
