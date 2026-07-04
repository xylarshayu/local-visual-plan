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
---

Standard Markdown prose here (headings, lists, tables, links, **bold**, inline
`code`, standard ``` fences). Custom blocks (below) are interleaved with prose.
```

- Frontmatter is a leading `---` fenced YAML-ish block of simple `key: value`
  lines. Only `title`, `objective`, `status` are recognized; unknown keys are
  ignored. `title` is required; the others are optional.
- Everything outside a recognized custom block is rendered as GitHub-flavored
  Markdown via vendored `marked`.

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
Info attrs: `title=<text>` (optional), `look=handDrawn|clean` (default
`handDrawn`). Body is raw Mermaid source. **Diagrams render hand-drawn by default**
(sketchy shapes + the vendored Virgil font); set `look=clean` for a crisp/classic
diagram where the sketch look hurts readability. For *which diagram type to use*
and per-type syntax, see **`references/diagrams.md`** (loaded on demand).

```diagram title="Upload flow"
flowchart LR
  U[User] --> A[upload action] --> S[(storage)]
```

**Output:** a `<figure data-block="diagram">` with optional `<figcaption>` and a
`<pre class="mermaid" data-look="handDrawn|clean">` holding the raw source
(rendered client-side by the inlined mermaid bundle; under `--lean`, shown as a
labeled code block instead). The hand-drawn defaults (`look:handDrawn` + Virgil
font) are applied globally by `interactivity.js`; a `look=clean` diagram carries a
small Mermaid frontmatter override prepended to its source. An author's own
frontmatter / `%%{init}%%` is left untouched.

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
`# ` starts a question; `default: <text>` gives the recommended default.

```questions
# Chunk uploads above 5MB?
default: No — single PUT until real >5MB usage appears.
# Per-user or per-org tokens?
default: Per-org — matches the existing ownership model.
```

**Output:** `<div data-block="questions">` of `<div class="question">` — each
carries an anchor (`data-pf-anchor` + `id`) and holds `.q-text`, an optional
`.q-default`, and an interactive `.q-form`:

```
<div class="q-form">
  <label><input type="radio" name="<q-anchor>" value="default" checked> Accept default</label>
  <label><input type="radio" name="<q-anchor>" value="custom"> Answer differently</label>
  <textarea class="q-custom" placeholder="Your answer…"></textarea>
</div>
```

The textarea is hidden by CSS until the *custom* radio is checked. Without JS the
form is inert (the answer just isn't captured) — the plan still reads fine.

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
| `step`      | each `li.step` in a `steps` block    | step title                           |
| `file`      | each `li.tree-row` in a `filetree`   | path                                 |
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
 "source":"<absolute path of the input plan.md, or null when rendered without a path>",
 "title":"<plan title>",
 "anchors":{"<anchor>":{"kind":"<kind>","label":"<human label>","lines":[start,end]|null}}}
</script>
```

`lines` are 1-based inclusive line numbers into the ORIGINAL `plan.md`
(frontmatter included in the count); `null` when not statically determinable
(e.g. paragraphs, or blocks nested inside a `tabs`/`collapsible` body). Any `</`
inside the JSON is written as `<\/` so the script can never terminate early.

**Embedded source** — the exact `plan.md` bytes, so the page is self-describing:

```
<script type="application/octet-stream" id="pf-source" data-encoding="base64">…</script>
```

**docId** — `"pf-"` + first 12 hex of the SHA-256 of the exact `plan.md` source.
Deterministic: the same input always yields the same `docId` (used to namespace a
reviewer's notes in `localStorage`). Also returned from `renderPlan()`.
