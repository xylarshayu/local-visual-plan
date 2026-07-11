---
name: present
description: Turn any topic — a codebase, a design, an argument, a concept, a pile of notes — into a single self-contained, interactive HTML page — chapters with a side nav, Mermaid diagrams, UI wireframes, callouts, data-model and api-endpoint blocks for schema/API shapes, annotated code and diffs, and open questions the reader can answer inline. Use when the user says "present X", "make a presentation" / "make a visual doc", "explain X visually", "give me a tour of Y", "teach me X as a page", "turn these notes/this design into a page", "/present", or otherwise wants to SEE and explore a topic instead of reading a wall of chat text. Also use when the user pastes a blob starting `<!-- presentation-feedback` — that's exported review feedback from a page you rendered earlier; resolve it against `references/feedback.md`. For an implementation plan that needs sign-off use present-plan; for a git-diff recap use present-recap. Renders fully offline from file:// — no SaaS, no account, no server, no network at view time.
license: MIT — see LICENSE and THIRD_PARTY_NOTICES.md
---

# Present

Turn a topic into a **fully-local** interactive HTML page: research it, write
it up in the documented block format, render it to one self-contained file,
open it, and hand it to the reader. Nothing leaves the machine.

## When to use it — and when to route elsewhere

This is the direct tool for "make me a page about X": explain a codebase or
architecture, give a tour of how something works, teach a concept, lay out an
argument, turn scattered notes or a design doc into something readable. The
topic doesn't have to be code — a decision memo, a process writeup, a
comparison of options are all fair game.

Two specific workflows get their own thin adapter skill on top of this one,
because each carries discipline beyond general presentation craft:

- An **implementation plan that needs sign-off** before code is written →
  `present-plan`.
- A **recap of a git diff** (branch, commit range, PR, working tree) →
  `present-recap`.

Everything else — explainers, tours, conceptual write-ups, "turn this into a
page" — is this skill, directly.

## Authoring craft

- **Right altitude.** Show the load-bearing thing — the key diagram, the one
  schema change, the signature that matters — not everything you know. A
  `diff` with a `@note:` on the key hunk beats pasting a whole file; one
  `data-model` block beats a wall of prose describing columns.
- **Chapters + side nav for long docs.** `<!-- chapter: Title -->` directives
  split one file into sections with a scrollspy sidebar and deep links — still
  one HTML file. Reach for this once a document has enough sections to want
  in-page navigation; skip it for a short page. Chapters also power **presenter
  mode** — a *Present* button in the page walks the reader one chapter at a
  time, with keyboard navigation and a clickable progress rail.
- **Diagrams and wireframes where they beat prose.** A `diagram` (Mermaid) for
  flows, sequences, state, or relationships; a `wireframe` for UI. Use prose
  for everything a picture wouldn't clarify.
- **Callouts for decisions and warnings.** A `callout tone=decision|warning|risk`
  keeps a load-bearing aside from getting lost in paragraph text.
- **`data-model` / `api-endpoint` for schema and API shapes** (see below) —
  reach for these over a Mermaid `erDiagram` or a prose description whenever
  the shape itself, or a change to it, is the point.
- **A `questions` block whenever you want the reader's input.** Every entry
  renders as a real form (Accept default / Answer differently) — don't ask
  "does this look right?" in chat when you can ask it on the page instead.

`references/format.md` is the **authoritative block catalog** — every block's
authoring syntax and output contract. Don't invent block types or attributes;
if it's not in `format.md`, it doesn't exist. `references/wireframe.md` (the
`.wf-*` class catalog for wireframes) and `references/diagrams.md` (which
Mermaid diagram type for which job) are loaded on demand — they don't cost
always-on context. Unknown blocks degrade to a labeled `<pre>`, so the `.md`
stays readable anywhere, even without this renderer.

## New: `data-model` and `api-endpoint`

Two blocks purpose-built for shapes a Mermaid diagram can't show a *change*
to:

- **`data-model`** — schema entities and fields, with `filetree`-style change
  flags (`+ ~ - .`), `was:` annotations for old values, PK/FK badges, and
  relation lines (Mermaid-ER-style) rendered as a plain list. Reach for this
  when the point is what changed about a schema, not just its current shape.
- **`api-endpoint`** — a method + path badge, flagged parameter lines
  (`path|query|header|body|auth`), and `request:` / `response <code>:` JSON
  sections rendered as zero-JS collapsible trees. Use it for a request/response
  contract, especially one that changed.

Both get field-level anchors like every other block — a reviewer can pin a
note on a single column or a single query param, not just the block as a
whole. Full authoring syntax lives in `references/format.md`.

## Render mechanics

The renderer lives next to **this `SKILL.md`** at
`<skill-dir>/renderer/render.mjs`, where `<skill-dir>` is the directory
containing this file (e.g. `~/.claude/skills/present` or
`~/.agents/skills/present`). Your working directory while researching is the
**user's project root**, NOT the skill dir, so invoke the renderer by that
resolved path — a bare `node renderer/render.mjs …` fails with "Cannot find
module".

```
node <skill-dir>/renderer/render.mjs <doc.md> --open
```

Stay in the user's project dir when you run this: the input file and the
default/`--out` output are resolved relative to your **current** directory
(not the skill dir), so a relative path lands in the user's project as
intended. (If you `cd` into `<skill-dir>` first, pass absolute paths instead.)

- `--lean` — drop the inlined Mermaid bundle for a tiny offline file (diagrams
  show as code instead).
- `--out <path>` — choose the output location; default is
  `./.visual-plans/<slug>/index.html`.
- Omit `--open` to render without launching a browser.

`--watch` re-renders on every save and serves the page at a loopback-only
localhost URL with SSE live reload (the file on disk stays offline-pure — the
reload snippet is injected at serve time only; the change-highlight baseline
is frozen at watch start). Useful while authoring a long doc; not for the
final handoff, which should be a plain render.

**How `--open` works (and why it always gives you something clickable).** It
tries the platform's openers (`$BROWSER` → `wslview` → `explorer.exe` →
`xdg-open`) and — regardless of whether any fired — **always prints two
targets**:
```
windows: \\wsl.localhost\<distro>\…\index.html   (WSL only)
url:     file:///…/index.html
```
**Surface that `url:` line (and on WSL the `windows:` path) to the user, every
time.** Many harnesses/IDEs (Claude Code included) auto-open a surfaced
`file://` link; where they don't, it's a one-click path. This is why opening
still works when the native openers can't — e.g. WSL with interop disabled,
where the printed UNC path opens straight from Windows anyway.

**Verify diagrams before presenting.** Run
`node <skill-dir>/renderer/check.mjs <output.html>` — a best-effort check that
loads the page in whatever headless Chromium it can find locally and fails,
listing captions, if any Mermaid diagram didn't produce an SVG (a plain syntax
slip otherwise ships silently). No local browser found → it skips cleanly;
treat that as a pass, not a blocker.

## Sharing the page

If `PRESENT_SHARE_URL` is set, offer to share the page after render: run
`node <skill-dir>/renderer/share.mjs <output.html> --server $PRESENT_SHARE_URL`
and surface the `url:` it prints exactly like the render step's own `url:`
line — same convention, same reason (many harnesses auto-open a surfaced
link). `--pr <n>` also posts that link as a PR comment via `gh`, using the
uploader's own auth — nothing on the VM ever touches GitHub. `--tunnel` skips
the VM for an ephemeral **public** link instead — serves the file locally and
tunnels it out — for "look at this now" before any PR exists; relay
share.mjs's public-link warning to the user every time, never swallow it.
Separately, `render.mjs --github` writes a `github.md` next to the output: a
degraded GitHub-flavored rendition (native `mermaid` fences, callouts as
GitHub alerts) for pasting straight into a PR comment, alongside or instead of
the hosted link.

## The feedback round-trip

The rendered page isn't read-only. In note mode, the reader can pin a note on
any anchored element (a heading, a paragraph, a step, a diff hunk, a table
cell, a whole block) marked either **for the agent** or **note to self**
(self-notes stay in the page but never leave it); each open `questions` entry
renders as a form — **Accept default** or **Answer differently** (leaving the
pre-selected default in place counts as accepting it); GFM task-list items
are tickable; and a **Review panel** collects everything. **Export** copies a
structured blob to the clipboard. Tell the reader this after you open the
page: pin notes, answer questions, then paste the export back into chat.

If a message **begins with** `<!-- presentation-feedback`, it's exported
review feedback, not new prose — process it as data. The full contract
(grammar + ingestion algorithm + a worked example) is
`<skill-dir>/references/feedback.md`; read it before acting the first time. In
short: verify the `doc`/`source`/docId still match the file you rendered from;
resolve each `[anchor]` — via the page's baked-in anchor map if you still have
it this session, else by matching the quoted excerpt against the source; act
on every note and every answer in document order; never silently skip a note —
if one can't be resolved, say so and ask. Then re-render and respond to each
note explicitly. Deliver those per-note responses on the page too: write them
to `.visual-plans/<slug>/replies.json` and re-render with `--replies <file>` —
each reply shows as an inline card at the element it answers, plus an "Agent
replies" list in the review panel. A re-render over a previous version
automatically highlights
what changed and gives the reviewer a ‹ n/m › changes navigator (`n`/`p`
keys) — surface the printed `changes:` line so they know it's there.

## Local & private

The output is a **single self-contained HTML file** — inlined CSS, inlined
vanilla JS for tabs / collapse / theme / annotation, (unless `--lean`) an
inlined Mermaid bundle that renders diagrams in the browser, and — when a
hand-drawn diagram is present — the Virgil font embedded as a base64 data URI.
No CDN, no web-font fetch, no external URLs: it opens straight from `file://`
and works with the network off. Any notes or answers the reader pins
also stay local — they live in the page's `localStorage` (or, where that's
blocked, in page memory) and only leave the machine when the reader copies the
Export text themselves. The renderer needs **no `npm install`** — `marked`,
`mermaid`, and the font are vendored.

Note: `wireframe` block bodies are passed through as HTML by design (you
author them, the reader views them locally) — only render files you trust.
</content>
