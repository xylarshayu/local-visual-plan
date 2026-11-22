# `plan.md` format — authoritative contract

This is the single source of truth shared by the **author** (the skill / agent
writing a plan) and the **renderer** (`render.mjs`). Every block lists its
authoring syntax AND the output HTML contract (a stable `data-block` attribute +
key classes) so the renderer, the stylesheet, and the tests all agree.

## File shape

```
---
title: Short plan title (≤ ~70 chars)
objective: One or two sentences on the outcome.
status: draft | proposed | approved
theme: mono | manual
repo: https://github.com/org/repo/blob/main
---

Standard Markdown prose here (headings, lists, tables, links, **bold**, inline
`code`, standard ``` fences). Custom blocks (below) are interleaved with prose.
```

- Frontmatter is a leading `---` fenced YAML-ish block of simple `key: value`
  lines. Only `title`, `objective`, `status`, `theme`, `repo` are recognized; unknown
  keys are ignored. Without a `title`, a `# H1` as the first line of the body
  is the title (shown once, as the page title), so a page can stay plain
  Markdown on GitHub.
- `theme` picks the palette. `mono` (default) is ink on white with one accent:
  colour means either "look here" (accent) or "this changed" (green/red), and
  diagrams render clean. `manual` restores the original warm palette with
  hand-drawn diagrams. The renderer's `--theme mono|manual` flag overrides the
  key. An unknown value warns and falls back to `mono`. The output `<html>`
  carries `data-pf-theme="mono|manual"`.
- `repo` is the URL that a stepper's `code:` and `docs:` paths are appended to, to make
  them links (a file URL base such as `.../blob/main`). It must be http(s), or
  it warns and the paths stay plain text. A page that cites more than one repo
  repeats the key with a short name first, `repo: Backend https://...`, one
  line per repo. The first is the page's own repo; the name is what the
  caption shows, so keep it short.
- Everything outside a recognized custom block is rendered as GitHub-flavored
  Markdown via vendored `marked`. A relative link to a sibling `.md` file
  (`ch2.md`, `./ch2.md#anchor`) becomes `ch2.html`, for pages rendered next to
  their sources with `--out`. Links into other folders are left alone.

## Custom blocks

A custom block is a fenced code block whose **info string** is one of the
recognized types below, optionally followed by `key=value` attributes:

````
```diff file=src/actions/upload.ts mode=split
...body...
```
````

Attribute values containing spaces **must** be quoted (`title="Upload flow"`);
an unquoted value runs to the next space. Quotes are optional otherwise.
**Unknown block types** must render as a labeled `<pre data-block="unknown"
data-type="...">` showing the raw body — never dropped, never executed.

### `steps` — ordered implementation steps
Line-oriented body. `# ` starts a step; under it:
- `reuse <path> — note` / `edit <path> — note` / `new <path> — note` /
  `delete <path> — note` declare a file the step touches (the ` — note` is
  optional). The verb becomes a colored tag.
- `> rationale` lines (one or more) explain the step.
- Blank lines are ignored.

```steps
# Add a size guard to the upload action
reuse src/lib/client.ts — uploadFile() already handles the PUT
edit src/actions/upload.ts — reject > 5MB before calling the client
new src/actions/validate-size.ts — pure size check, unit-tested
> Reuse the existing client; only the guard + validator are genuinely new.
```

**Output:** `<ol data-block="steps">` of `<li class="step">`, each with
`.step-title`, an optional `.step-files` list whose items carry
`data-change="reuse|edit|new|delete"`, and `.step-why`.

### `filetree` — file map with change flags
Each line: optional 2-spaces-per-level indentation, a flag char, a space, the
path, and an optional ` — note`. Flags: `+` added, `~` modified, `-` deleted,
`.` unchanged/context.

```filetree
. src/actions/
~   src/actions/upload.ts — guard added
+   src/actions/validate-size.ts — new
- src/legacy/old-upload.ts — removed
```

**Output:** `<div data-block="filetree">` containing a `<ul>` tree; each entry is
`<li class="tree-row" data-change="added|modified|deleted|unchanged"
data-depth="N">` with `.tree-path` and optional `.tree-note`.

### `diff` — annotated diff
Info attrs: `file=<path>` (label), `mode=split|unified` (default `unified`).
Body is a standard unified diff (`@@`, `+`, `-`, ` ` lines). An optional line of
the form `@note: text` immediately after a `@@` hunk header renders as a callout
attached to that hunk.

```diff file=src/actions/upload.ts mode=split
@@ -10,6 +10,9 @@ export default defineAction({
@note: The only behavioral change — everything else is plumbing.
   run: async ({ file }) => {
+    if (file.size > MAX_BYTES) {
+      throw new ActionError('file too large')
+    }
     return uploadFile(file)
```

**Output:** `<figure data-block="diff" data-mode="split|unified">` with an
optional `<figcaption>` (the file label), a table/columns of lines each carrying
`data-line="add|del|ctx|hunk"`, and `.diff-note` callouts.

### `code` — annotated snippet
Info attrs: `lang=<id>`, `file=<path>` (optional label), `hl=<ranges>` (e.g.
`hl=3-5,9` highlights those 1-based lines). Optional `@note line=N: text` lines
at the very top of the body attach margin notes to line N.

```code lang=ts file=src/actions/validate-size.ts hl=2
export const MAX_BYTES = 5 * 1024 * 1024
export function isTooLarge(n: number) { return n > MAX_BYTES }
```

**Output:** `<figure data-block="code" data-lang="ts">` with optional
`<figcaption>`, a numbered `<ol class="code-lines">` whose highlighted lines
carry `data-hl="1"`, and `.code-note` callouts.

### `diagram` — Mermaid
Info attrs: `title=<text>` (optional), `look=handDrawn|clean` (default `clean`,
or `handDrawn` under `theme: manual`). Body is raw Mermaid source. Diagrams
render clean by default; set `look=handDrawn` (sketchy shapes plus the vendored
Virgil font) only for a deliberately rough, conceptual sketch. For *which diagram type to use*
and per-type syntax, see **`references/diagrams.md`** (loaded on demand).

```diagram title="Upload flow"
flowchart LR
  U[User] --> A[upload action] --> S[(storage)]
```

**Output:** a `<figure data-block="diagram">` with optional `<figcaption>` and a
`<pre class="mermaid" data-look="handDrawn|clean">` holding the raw source
(rendered client-side by the inlined mermaid bundle; under `--lean`, shown as a
labeled code block instead). Each diagram carries a small Mermaid frontmatter
setting its look. Under `mono`, `interactivity.js` renders with Mermaid's `base`
theme and `themeVariables` read from the page's CSS tokens, so diagrams follow
light and dark. When any diagram on the page is hand-drawn, Virgil becomes the
diagram font for the whole page (Mermaid measures text with one global font).
An author's own frontmatter / `%%{init}%%` is left untouched.

### `wireframe` — UI mockup
Info attrs: `surface=page|panel|popover|sheet|toolbar` (default `page`),
`title=<text>`, `style=clean|sketchy` (default `clean`). Body is **constrained
HTML** using the documented `.wf-*` classes (see `wireframe.md`). The renderer
wraps the body in the chosen surface chrome; it does not invent layout.

```wireframe surface=page title="Settings — after"
<div class="wf-toolbar"><span class="wf-title">Settings</span></div>
<div class="wf-row"><button class="wf-btn wf-primary">Save</button></div>
```

**Output:** `<figure data-block="wireframe" data-surface="page">` with optional
`<figcaption>`, the surface frame `<div class="wf-screen wf-<surface>">`, and the
author's body inside. See `wireframe.md` for the full class catalog and quality
bar.

## Grouping directives (tabs / collapsible)

Because fences cannot nest, grouping uses HTML-comment directives placed in the
prose (they survive Markdown and are invisible in any plain renderer):

```
<!-- tabs:start -->
<!-- tab: Before -->
   ...any prose or blocks...
<!-- tab: After -->
   ...any prose or blocks...
<!-- tabs:end -->

<!-- collapsible: Verification details -->
   ...any prose or blocks...
<!-- collapsible:end -->
```

**Output:** tabs → `<div data-block="tabs">` with a `.tab-bar` of buttons and
`.tab-panel`s (first active); collapsible → `<details data-block="collapsible">`
with a `<summary>` carrying the label. Interactivity is the inlined
`interactivity.js` (no framework).

## Rendering pipeline (guidance for the renderer)

1. Parse and strip frontmatter.
2. Extract recognized custom fenced blocks, replacing each with a unique
   placeholder token; render each block to HTML via its dedicated renderer.
3. Transform grouping directives into wrapper markup.
4. Run `marked` on the remaining Markdown.
5. Re-insert the rendered block HTML at its placeholders.
6. Inject the result into `template.html` between the body markers, inlining
   `styles.css`, `interactivity.js`, and (unless `--lean`) `vendor/mermaid.min.js`.

## Escaping

- Prose and all text extracted from `steps`/`filetree`/`questions`/`code`/`diff`
  text content MUST be HTML-escaped before insertion.
- `wireframe` bodies are intentionally passed through as HTML (authored by the
  agent, viewed locally). Document this trust boundary; do not accept untrusted
  plan files.
- The output is a local file:// document; there is no server and no untrusted
  third-party input in the normal flow.

### `questions` — open questions
`# ` starts a question; `default: <text>` gives the recommended default;
optional `option: <label> — <caption>` lines offer concrete alternative
answers (the ` — caption` is optional and renders as a muted description).

```questions
# Chunk uploads above 5MB?
default: No — single PUT until real >5MB usage appears.
option: Yes, behind a flag — most control, most plumbing
option: Yes, always
# Per-user or per-org tokens?
default: Per-org — matches the existing ownership model.
```

**Output:** `<div data-block="questions">` of `<div class="question">` — each
carries an anchor (`data-pf-anchor` + `id`) and holds `.q-text`, an optional
`.q-default`, and an interactive `.q-form`:

```
<div class="q-form">
  <label><input type="radio" name="<q-anchor>" value="default"> Accept default</label>
  <label class="q-opt" data-pf-anchor="<q-anchor>:opt-<slug>" id="…">
    <input type="radio" name="<q-anchor>" value="option" data-opt="<label>">
    <span class="q-opt-text"><span class="q-opt-label">…</span><span class="q-opt-caption">…</span></span>
  </label>
  <label><input type="radio" name="<q-anchor>" value="custom"> Answer differently</label>
  <textarea class="q-custom" placeholder="Your answer…"></textarea>
  <textarea class="q-note" placeholder="Optional note on your answer…"></textarea>
</div>
```

**Nothing is pre-selected**: explicitly clicking *Accept default* is a
deliberate answer (it records and counts toward the review-progress meter),
while an untouched question still exports its accepted default — the intent
gesture and the export semantics are decoupled on purpose. Each `option:`
line is a child anchor (kind `opt`, `<q-anchor>:opt-<label-slug>`). The
custom textarea is revealed when the *custom* radio is checked; the
answer-note textarea once any answer is selected. Without JS the form is
inert (the answer just isn't captured) — the plan still reads fine.

### `callout` — decision / warning / risk aside
Info attrs: `tone=info|decision|warning|risk` (default `info`), `title=<text>`
(optional; quote it if it contains spaces). Body is **Markdown** (rendered like
prose; remote refs neutralized, text escaped).

```callout tone=warning title="Irreversible once shipped"
The anchor scheme becomes a public contract. Prefer **content-derived** ids so
minor edits don't orphan a reviewer's notes.
```

**Output:** `<aside data-block="callout" data-tone="…">` with an optional
`<p class="callout-title">` and a `.callout-body`. All four tones are styled for
light and dark themes.

### `data-model` — schema / entities with change flags
A line-oriented description of tables/entities and their fields, annotated with
the same `+ ~ - .` change flags as `filetree` (added / modified / deleted /
unchanged). Blank lines are ignored. Info attr: `title=<text>` (optional
figcaption). Line types:

- **ENTITY** — a flag at indent 0 followed by a single space and a name:
  `<flag> <name>`. Starts an entity card. May carry a trailing ` — note` (e.g. a
  deleted entity's reason). The card's change comes from **its own** flag; a `~`
  on one of its fields does **not** change the entity's flag.
- **FIELD** — the name indented ≥2 spaces past the flag:
  `<flag> <name> <type…> [PK|FK -> <target>] [— note]`. `<type…>` is every token
  between the name and the first of `PK`, `FK`, or `—`. `PK` marks a primary key;
  `FK -> <target>` marks a foreign key and records its target.
- **RELATION** — an indent-0 line containing a Mermaid-ER cardinality token (a
  `--` core hugged by `|o{}` decorations, e.g. `}o--||`, `||--o{`):
  `<lhs> <cardinality> <rhs> [: label]`. Rendered as a plain list under the
  cards — **no** graph layout (use a `diagram` for a picture).
- A `— note` (or ` -- note`) beginning `was:` is a **previous value**, rendered
  struck-through beside the field/entity. Any other note renders plainly.
- Anything unparseable is preserved as a **muted raw line** — never dropped.

```data-model title="Billing schema"
. user
~   plan_id uuid FK -> plan.id — was: text
+   trial_ends_at timestamptz — nullable
.   email text — unique
+ plan
+   id uuid PK
+   price_cents int
- legacy_tiers — table dropped
user }o--|| plan : belongs to
```

**Output:** `<figure data-block="data-model">` + optional `<figcaption>`; a
`.dm-grid` of `.dm-entity[data-change="added|modified|deleted|unchanged"]` cards,
each with a `.dm-entity-name` and `.dm-field[data-change]` rows containing
`.dm-field-name`, `.dm-field-type`, a `.dm-key[data-key="pk|fk"]` badge (FK shows
its `-> target`), optional `.dm-was` (struck) and `.dm-note`; then a
`.dm-relations` list of `.dm-relation` items.

### `api-endpoint` — HTTP endpoint contract
Describes one HTTP endpoint: a method/path header, parameters annotated with the
`+ ~ - .` change flags, and request/response JSON bodies. Info attrs:
`method=<verb>` (displayed upper-cased as a per-verb-tinted badge), `path=<path>`,
`title=<text>` (optional figcaption). A missing `method`/`path` degrades
gracefully (the badge/path is simply omitted). Body line types:

- **PARAM** — everything before the first section line: `<flag> <in> <rest…>
  [— note]` where `<in>` ∈ `path | query | header | body | auth`. For `auth` the
  rest is free text (e.g. `Bearer org token`); for the others the first token of
  the rest is the param name and the remainder its type. The `was:` note
  convention is identical to `data-model`. A line whose second token is not a
  valid `<in>` is preserved as a **muted raw line**.
- **SECTION** — `request:` or `response <code>:` alone on a line. The section body
  is every following line until the next section header or EOF, expected to be
  **JSON**. Valid JSON renders as a server-side collapsible tree (nested
  `<details>/<summary>`, **zero JS**): top-level open, containers deeper than
  depth 2 collapsed by default, values styled by type. If `JSON.parse` fails the
  raw text is shown escaped in `<pre class="api-raw">` with a "not valid JSON"
  hint — never a crash.

```api-endpoint method=POST path=/v2/uploads title="Create upload"
. auth Bearer org token — was: user token
+ query expires_in int — optional, seconds, default 3600
~ body name string — now required
request:
{ "name": "logo.png", "size_bytes": 51203 }
response 201:
{ "id": "up_9f2", "url": "…" }
response 413:
{ "error": "file too large" }
```

**Output:** `<figure data-block="api-endpoint">` + optional `<figcaption>`; an
`.api-head` holding an `.api-method[data-method]` badge + `.api-path`; an
`.api-params` list of `.api-param[data-change]` rows (each with an
`.api-in[data-in]` badge, name/type, optional `.api-was`/`.api-note`); and one
`.api-section[data-section="request"]` or
`[data-section="response"][data-code="…"]` per section, each with an `.api-code`
badge and a `.json-tree` (or the `<pre class="api-raw">` fallback).

### `figure`: a drawn SVG

A figure is geometry drawn once in an SVG file; the facts about it stay in the
markdown. Use one when Mermaid cannot lay the picture out (see
`references/figures.md` for when, and for the house figures to start from).

````
```figure src=figures/request-path.svg title="Request path"
A request crosses the gateway to the orders service, which writes one database.
```
````

- `src` (required): an `.svg` file, relative to `plan.md` (to the working
  directory when the source has no path). It is inlined, so the page stays one
  file.
- `title` (optional): the caption and the figure's accessible name.
- Body (required): one or two sentences saying what the figure shows. It
  becomes the SVG's accessible description. Anything the reader must know also
  goes in prose.

The file contract is linted at render time. Each breach is a render warning.

- The root is `<svg>` with a `viewBox`; its `width`/`height` are dropped and the
  stage sizes it: up to 1.25x the viewBox width when the column has room
  (draw at the size it should appear) and never narrower than 0.8 of it.
  A narrower screen scrolls the stage sideways instead of shrinking the text.
  The `<figure>` carries the drawn width as `style="--fig-w:720px"`.
- Colour comes from tokens only. A paint value (`fill`, `stroke`, `stop-color`,
  or the same inside `style`) is `none`, `currentColor`, `transparent`,
  `inherit`, `var(--...)` or `url(#...)`. The defaults are ink strokes and ink
  text with no fill. Class `box` fills a shape with the page background so it
  hides lines behind it, class `solid` fills it with ink, class `muted` uses
  the muted ink, class `mono` sets text in the mono font. A `<symbol
  class="mark">` draws filled, and a `<use class="mark">` of it is a faint
  watermark (0.3 opacity; 0.55 and accent while its part is current). `data-role="guide"` is a faint rule (lane lines),
  `data-role="hidden"` a faint dashed line (boundaries, what is not seen).
  Change is `data-change="add|del"` (added in the positive colour, removed in
  the negative colour, dashed).
- `data-accent` marks the focal element, at most two per figure. Inside a
  `stepper` the stepper sets the accent instead.
- `data-part="name"` names a group that a stepper or the prose refers to.
  Names are unique within the file. Add `data-future="hidden"` to a part
  that must not appear before its step (a copy that does not exist yet);
  other future parts are only faint.
- `data-flow` on an edge's line `<path>` (not its arrowhead) makes a small
  accent bead run along the line, in the direction it is drawn, when its
  part becomes current in a stepper: three runs, then it rests until the
  step is shown again. Draw each line from source to target. It
  does nothing in a plain `figure`, under reduced motion, in print, or
  without script.
- `data-lift` on a part (a layer of an isometric stack) makes it rise 20
  units while it is current in a stepper, and ghosts the `data-lift` layers
  drawn after it (the ones over it), so the stack shows which layer the step
  is about. Draw the stack bottom layer first. It does nothing in a plain
  `figure` or in print.
- `data-rise` on a part (a building on an axonometric plan) makes it rise 12
  units while it is current in a stepper; nothing is ghosted. It does nothing
  in a plain `figure` or in print.
- Not allowed, and removed with a warning: `<script>`, `on*` attributes,
  `<foreignObject>`, `<style>` (it would restyle the whole page), and any
  `href` that is not `#id`.
- `<a href="#anchor">` around a `<text>` is a link to another place on the
  page (a heading's `h:...` id or a block's anchor, such as
  `stepper:inside-the-workers`). It is drawn in accent and underlined. A target
  that is not on the page warns.
- Text is `<text>` at 12 to 14 user units and inherits the page font.

**Output:** `<figure data-block="figure">` with an optional `<figcaption>` and a
`.figure-stage` holding the inlined `<svg role="img">`, whose `<title>` and
`<desc>` carry the title and body. Every `id` in the SVG (and each `#id`
reference) is prefixed with the block anchor, so two figures may both use
`id="arrow"`.

### `stepper`: a guided walk through a figure

A stepper walks the reader through one figure a step at a time. It is for ideas
that are temporal or causal: what happens in order, and what is true after each
step. The figure is the stage; each step lights the parts it is about and says
in words what the idea is and what changed.

````
```stepper figure=figures/request-path.svg title="One request, end to end"
counter: sent | Requests sent
counter: stored | Rows written
switch: Network

# The browser sends the request
parts: browser e-gateway gateway
needs: switch
set: sent=1
key: Nothing leaves the browser until the user submits.
changed: One request is in flight.

The browser serialises the form and sends it to the gateway.

# The service writes the row
parts: gateway e-service service e-db db
needs: switch
set: stored=1
key: The database write is the commit point.
changed: One row exists.
changed: The request is answered.

# The network is down
held
parts: browser
key: The form keeps its input and retries; the user loses nothing.
changed: Requests sent stays at 0.
```
````

Lines before the first `#` set up the stepper:

- `counter: name | Label`, at most three. Every counter starts at `0`.
- `switch: Label`, at most one. It starts on. Only the header declares it.
  The figure can follow it like a state: `data-show="switch=on"` and
  `data-show="switch=off"`.
- `state: name value value ...` names a figure state and its values; the first
  is the initial one. A step changes it with `set: name=value`, carried
  forward like a counter. In the SVG, a group with `data-show="name=value"` is
  shown only while the state has that value (it fades in and out), so draw
  each position or look once per value. A state is not shown as a counter.
- `code: part path` points a part at its representative file or directory,
  relative to the repo root. Repeat the line for more paths. Each step lists the
  paths of its own parts under "In the code", in the narration rail (never
  inside the figure), linked when the frontmatter sets `repo:`. With named
  repos, `code: part Name path` cites a path in that repo; a path with no name
  is in the first repo. Each item then shows its repo name before the path.
  The directory part is drawn faint and the file name in full ink. A short
  note may follow the path after ` | `: `code: queue src/queue.ts | enqueue, drain`.
- `docs: part path` is the same for a document (a design doc, a runbook),
  listed under "In the docs". Put the section names in the note:
  `docs: queue Docs guide/jobs.md | Retries, Dead letters`.

Each `# title` starts a step. Its setting lines come first, in any order;
everything after them is the narration, in Markdown.

- `parts:` the `data-part` names this step is about, separated by spaces.
- `key:` the key idea, one sentence. Required.
- `changed:` one item of "what changed"; repeat the line for more.
- `set: name=value, name=value` new counter or state values. Counter values are
  text, shown as written; a state value must be one of its values. A counter or
  state not set keeps its value from the step before.
- `needs: switch` marks a step that only happens with the switch on.
- `held`, alone on a line, marks the held step: it is shown in place of any
  `needs: switch` step while the switch is off. At most one; it is not in the
  step bar.
- `off: <title>` makes the step an off step: while the switch is off it is
  shown in place of the step with that title. It is not in the step bar. Use
  it when one step plays out differently with the switch off; use `held` when
  every step that needs the switch stops the same way. An off step wins over
  `held` for its step.

Part states follow from the steps: a part named by the current step is
**current** (accent), a part named by an earlier step is **past** (ink), and a
part not yet named is **future** (faint: lower opacity, same line style, so
dash keeps its meaning). A part no step ever names
is always ink, as context.

While the switch is off, the story is the step list with the `needs: switch`
steps left out and the off steps swapped in. Past parts, counters and states
follow that story: an off step starts from the story's values before it, then
applies its own `set:`; a held step shows the story so far plus its own `set:`,
wherever it stands in.

Lint warnings: the figure is missing (the steps still render); a `parts:` name
the figure does not have; a `set:` name that is not a counter or state, or a state value it does not
have; a `state:` line with fewer than two values, or a name that is also a
counter; a `data-show` naming a state or value the header does not declare,
or used in a plain `figure`; a step with no
`key:`; `needs: switch`, `held` or `off:` with no switch in the header; a switch with
no held or off step, or a held step with no `needs: switch` step; an `off:`
title that names no step, or two off steps for one step; more than three counters, one switch, one held step, or ten
steps; a `code:` or `docs:` line without a path, for a part the figure does not have, or
with an absolute or `..` path (dropped); more than one `repo:` without names;
and, when the page sits in a git repo, a `code:` or `docs:` path in the first repo that
does not exist from the repo root (kept, so a stale page says so on its next
render). Paths in other repos are not checked.

**Behaviour.** Without script, and in print, every step is laid out in order
under the figure, which shows all parts in ink and each state at its first
value. With script, the stepper shows
one step at a time with a step bar (one button per step, numbered), previous
and next buttons, the counters under the figure, and the switch. The
arrow keys move between steps while focus is inside the stepper. The narration
rail is `aria-live="polite"`. Part changes use the motion tokens; with
`prefers-reduced-motion` they are instant. On a wide screen a stepper leaves
the 1000px prose column: it grows as far as its figure at 1.25x plus a rail of
up to 360px need, within a 1440px page with 24px sides and clear of the side
nav. The figure column is sticky and its drawing is capped so it and the
controls fit in the window. Print keeps the stepper in the column. On a wide
stage the rail sits right of the figure; on a narrow one it sits below, and the stage (same minimum
width as `figure`) scrolls to keep the current parts in view. While the switch is off, steps that need it are dashed
in the step bar. Every part some step names gets `data-goto`: clicking it
(outside a link) goes to the first step that names it, unless the current
step names it too; hovering tints it toward the accent, and a `data-rise`
part lifts 4 units.

**Output:** `<figure data-block="stepper">` with an optional `<figcaption>`, a
`.stepper-stage` holding the inlined SVG (same contract as `figure`), a
`.stepper-counters` row of `[data-counter]` items, a `.stepper-controls` bar
(hidden until script runs), and an `<ol class="stepper-steps">` of
`<li data-parts data-counters data-off-counters data-needs>` steps (the
off counters only with a switch), each with an `<h3>`, the
narration, a `.stepper-key` and a `ul.stepper-changed`; the held step is an
`<aside class="stepper-held">` with the same shape, and an off step an
`<aside class="stepper-off" data-off-for="n">` (n is the 0-based step it
stands in for). Each step is its own
feedback anchor.

### `embed`: a sandboxed interactive page

The last resort, for an interaction no figure or stepper can show (a
simulation, a 3D object you turn). At most two per page.

````
```embed src=embeds/pendulum.html poster=embeds/pendulum.png title="Pendulum" height=300
Drag the length slider: a longer pendulum swings more slowly.
```
````

- `src` (required): a self-contained local `.html` file, relative to `plan.md`,
  at most 2 MB. Inline its scripts, styles, images and fonts (`data:` URLs);
  the embed has no network. A URL is refused.
- `poster` (required): an image of the embed (`.svg`, `.png`, `.jpg`,
  `.webp`), inlined. Print, no-script and any reader who never presses Run
  see only the poster, so capture it in the state that teaches. Without a
  poster nothing is embedded; only the body renders.
- `height` (optional): the running frame's height in pixels, default `420`.
- Body (required): what to try and what it shows, as markdown. It is also the
  poster's alt text.

No fact lives only inside an embed: tools that keep the page current cannot
read one. Anything the reader must know is in the body or the prose.

The page's tokens (`--bg`, `--fg`, `--fg-muted`, `--accent`, `--sans`, ...)
are set on the embed's `:root`, so `var(--fg)` follows the page, and a running
embed reloads when the theme changes.

**Safety.** Run builds an `<iframe sandbox="allow-scripts">` from the file
(`srcdoc`), prefixed with a Content Security Policy that allows inline script
and style and `data:`/`blob:` media, and nothing else. Every page also carries
`frame-src 'none'`, so no frame can load a URL. So the embed:

- runs in an opaque origin: it cannot read the page, its notes, storage or
  cookies, open windows, submit forms or navigate the page;
- cannot load or send anything over HTTP: `fetch`, XHR, WebSocket, beacons,
  remote scripts, styles, images and fonts are all blocked, and so is
  navigating its own frame anywhere.

One channel remains, because no CSP closes it: WebRTC (STUN) traffic. It can
carry what is in the embed file and anything the reader types into the embed,
and it reveals that Run was pressed and from where. Treat an embed file like
the rest of the page's source, and do not embed code you have not read. A
remote reference in the file is a render warning.

Lint warnings: missing or remote `src`, missing or unsupported `poster`, an
empty body, more than two embeds, a file over 2 MB, a remote reference.

**Output:** `<figure data-block="embed">` with an optional `<figcaption>`, a
`.embed-stage` holding the poster `<img>`, a `button.embed-run` (hidden until
script runs) and the file, escaped, in `data-srcdoc`; then the body in
`.embed-note`.

## Chapters (side-nav sections)

An opt-in top-level directive that splits the document into navigable sections
with a sticky side nav. Invisible to any plain Markdown renderer (it's an HTML
comment), so the `.md` still degrades gracefully.

```
<!-- chapter: The problem -->
…prose and blocks…
<!-- chapter: Architecture -->
…
```

- Each `<!-- chapter: Title -->` starts a chapter that runs until the next marker
  or end of file.
- Content **before** the first marker becomes an intro chapter labeled
  **"Overview"**.
- **Limitation:** chapter markers are only recognized at the top level. A marker
  placed inside a `tabs`/`collapsible` body is **not** processed (it stays an
  inert HTML comment). Keep chapter markers in the main flow.

**Output:** each chapter is a `<section class="pf-chapter" data-pf-anchor=
"chapter:<slug>" id="chapter:<slug>">` with a `<h2 class="pf-chapter-heading">`
title; a `<nav class="pf-sidenav">` of `#chapter:<slug>` links is injected and
`<body>` gains `data-has-chapters="true"` to switch to the two-column layout
(left sidebar on wide screens, a collapsible disclosure on narrow ones).
`interactivity.js` provides scroll-spy highlighting. With no markers present the
page is byte-for-byte the same as before.

## Anchors & feedback plumbing (normative output contract)

Every render bakes in stable anchors, an anchor→line map, and the plan source, so
a reviewer's notes resolve straight back to `plan.md` line ranges. This is a
public contract other tools code against.

**Anchor attribute.** Every addressable element carries BOTH
`data-pf-anchor="<anchor>"` and `id="<anchor>"`.

**Anchor grammar.** `<kind>:<slug>` or `<kind>:<slug>:<n>` where `n>=2` is
appended on collision, in document order. Diff hunks:
`<parent-diff-anchor>:h<i>` (`i` 1-based hunk index; on the hunk header row).
Nested block members extend their parent block's anchor the same way: a
`data-model` entity is `<block-anchor>:<entity-slug>` and a field
`<block-anchor>:<entity>.<field>` (slugged); an `api-endpoint` param is
`<block-anchor>:<param-slug>` (auth uses `auth`) and its sections are
`<block-anchor>:request` / `<block-anchor>:resp-<code>`.
Slugs reuse `slugify()` (lowercase, NFKD, non-alphanumeric → `-`, trimmed).

**Kinds and slug sources.**

| kind        | element                              | slug source                          |
| ----------- | ------------------------------------ | ------------------------------------ |
| `h`         | prose headings `h1`–`h6`             | heading text                         |
| `p`         | prose paragraphs (top-level `<p>`)   | first ~6 words                       |
| `li`        | each prose list item `<li>` (`<ul>`/`<ol>`, nested) | item's own leading text, first ~6 words |
| `task`      | each GFM task-list item (`- [ ]` / `- [x]`) | item's own leading text, first ~6 words (label keeps up to 80 chars) |
| `table`     | each prose GFM `<table>`             | header-row text, first ~6 words      |
| `row`       | each body `<tr>` of a prose table    | `<table-anchor>:<leading-cell text, ~4 words>` |
| `cell`      | each body `<td>` of a prose table    | `<row-anchor>:<column-header>` (headerless → `c<n>`) |
| `pre`       | plain fenced code blocks (```` ```js ```` etc. — not the custom `code` block) | language + first ~4 words of code |
| `step`      | each `li.step` in a `steps` block    | step title                           |
| `file`      | each `li.tree-row` in a `filetree`, and each file line inside a step (`<step-anchor>:<path>`) | path |
| `diff`      | `figure[data-block=diff]`            | `file` attr, else `diff-<index>`     |
| `code`      | `figure[data-block=code]`            | `file` attr, else `<lang>-<index>`   |
| `diagram`   | `figure[data-block=diagram]`         | `title` attr, else `diagram-<index>` |
| `wireframe` | `figure[data-block=wireframe]`       | `title` attr, else `wireframe-<index>` |
| `q`         | each `.question` in a `questions`    | question text                        |
| `callout`   | `aside[data-block=callout]`          | `title` attr, else `<tone>-<index>`  |
| `chapter`   | each chapter `<section>`             | chapter title                        |
| `data-model`| `figure[data-block=data-model]`      | `title` attr, else `data-model-<index>` |
| `entity`    | each `.dm-entity` in a `data-model`  | `<block-anchor>:<entity-name>`       |
| `field`     | each `.dm-field` in a `data-model`   | `<block-anchor>:<entity>.<field>`    |
| `relation`  | each `.dm-relation` line in a `data-model` | `<block-anchor>:rel-<lhs>-<rhs>` |
| `api-endpoint` | `figure[data-block=api-endpoint]` | `method` + `path`, else `title`, else `api-endpoint-<index>` |
| `param`     | each `.api-param` in an `api-endpoint` | `<block-anchor>:<param-name>` (auth → `auth`) |
| `request`   | the request `.api-section`           | `<block-anchor>:request`             |
| `response`  | each response `.api-section`         | `<block-anchor>:resp-<code>`         |

Prose `p` anchors (and nested-segment anchors) come from paragraphs inside tabs,
collapsibles, and chapters too.

**Anchor map** — a JSON island baked into the page (end of `<body>`):

```
<script type="application/json" id="pf-anchor-map">
{"version":1,
 "docId":"pf-<first 12 hex of sha256 of the exact plan.md source>",
 "renderedAt":"<ISO 8601 timestamp of this render>",
 "source":"<absolute path of the input plan.md, or null when rendered without a path>",
 "title":"<plan title>",
 "anchors":{"<anchor>":{"kind":"<kind>","label":"<human label>","lines":[start,end]|null,"sig":"<8 hex>"?}}}
</script>
```

`lines` are 1-based inclusive line numbers into the ORIGINAL `plan.md`
(frontmatter included in the count); `null` when not statically determinable
(e.g. paragraphs, or blocks nested inside a `tabs`/`collapsible` body). Any `</`
inside the JSON is written as `<\/` so the script can never terminate early.

`sig` (optional, additive since 2026-07) is the first 8 hex of the SHA-256 of
the element's whitespace-collapsed source text — the content fingerprint the
re-render diff below uses to tell an edited element from an untouched one.
Absent when the element has no derivable source text.

`renderedAt` (additive since 2026-07) is the ISO timestamp of this render;
each version-history entry (below) carries forward the timestamp of the
version it preserves.

**Change highlights (re-render diff).** When the renderer is given the previous
version of the plan — automatically, by lifting `pf-source` out of the page it
is about to overwrite at the output path, or explicitly via `--prev <old
plan.md | old index.html>`; disabled with `--fresh`; under `--watch` the
baseline is frozen at watch start, so the page accumulates everything changed
during the session — it re-renders the old source in memory and compares
anchor maps by `sig`:

- same anchor, same `sig` → untouched; same anchor, different `sig` →
  `data-pf-changed="edited"` on the element
- anchor not in the old map with an unseen `sig` → `data-pf-changed="new"`
  (verbatim-moved content — same `sig` elsewhere in the old map — is NOT
  marked)
- old anchors that vanished (and whose `sig` isn't anywhere in the new map)
  are listed as removals

and bakes the result into a second JSON island:

```
<script type="application/json" id="pf-changes">
{"version":1,"prevDocId":"pf-…",
 "changes":[{"anchor":"<anchor>","type":"edited"|"new"}, …],
 "removed":[{"anchor":"<anchor>","kind":"<kind>","label":"<label>"}, …]}
</script>
```

The annotation layer styles the marked elements (accent bar + tint), demotes a
marked container whose only change is a marked descendant to
`data-pf-changed="parent"` (kept quiet), and shows a floating ‹ n/m › changes
navigator (keys `n`/`p`) plus a "Changed in this version" list in the review
panel. The CLI prints `changes: <e> edited, <n> new, <r> removed` when a diff
ran.

**Version history** — each re-render also prepends the previous version's
*stripped* anchor map — kind + label + `sig` only; line ranges are dropped,
since they only mean anything against that version's source — to a third JSON
island, newest first, capped at 8 entries:

```
<script type="application/json" id="pf-history">
{"version":1,"entries":[
 {"docId":"pf-…","renderedAt":"<ISO timestamp>"|null,
  "anchors":{"<anchor>":{"kind":"<kind>","label":"<label>","sig":"<8 hex>"?}}}, …]}
</script>
```

The changes navigator grows a version dropdown ("vs v3", "vs v2", …) that
re-diffs the current version against ANY listed entry entirely in the
browser — the same `sig` comparison as above — and re-highlights on the fly.

**Embedded source** — the exact `plan.md` bytes, so the page is self-describing:

```
<script type="application/octet-stream" id="pf-source" data-encoding="base64">…</script>
```

**docId** — `"pf-"` + first 12 hex of the SHA-256 of the exact `plan.md` source.
Deterministic: the same input always yields the same `docId` (used to namespace a
reviewer's notes in `localStorage`). Also returned from `renderPlan()`.
