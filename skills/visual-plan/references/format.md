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

**Output:** `<div data-block="questions">` of `<div class="question">` each with
`.q-text` and optional `.q-default`.
