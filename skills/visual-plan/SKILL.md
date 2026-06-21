---
name: visual-plan
description: Turn an implementation plan into a single self-contained, interactive HTML page you can review and approve locally — ordered steps, file trees, annotated diffs and code, Mermaid diagrams, wireframe mockups, before/after tabs, and open questions. Use when the user says "make a visual plan", "plan this visually", "show me a plan I can review/approve", "/visual-plan", or otherwise needs to SEE and sign off on a direction before code is written. Everything renders fully offline from file:// — no SaaS, no account, no server, no network at view time.
---

# Visual Plan

Produce a **fully-local** visual plan: research the codebase read-only, write a
`plan.md` in the documented block format, render it to one self-contained
interactive HTML file, open it, and ask for sign-off. Nothing leaves the machine.

## When to use it

Use it when the user needs to **see and approve a direction** before you build:
a multi-file feature, a refactor with hard-to-reverse choices, a UI change worth
mocking, anything where a wall of chat text would bury the decision.

**Skip it** for truly trivial, low-risk work — a one-line fix, a rename, a typo,
a single obvious edit. Don't ceremony-wrap a change that needs no approval; just
do it. When in doubt about scope, a quick plan is cheap and the page is the
approval gate anyway.

## Planning discipline

This discipline is adapted from BuilderIO's MIT-licensed `BuilderIO/skills`
(`visual-plan` / `visual-recap`). We keep the planning rigor; the rendering is
ours and 100% local.

- **Research the real files first.** Read the actual code before planning. Cite
  concrete paths, functions, and types — never plan against an imagined codebase.
- **Lead with reuse.** For every step, name what it *reuses* before what it
  *adds*. The `steps` block has explicit `reuse` / `edit` / `new` / `delete`
  verbs for exactly this — most steps should start with `reuse`.
- **Decide hard-to-reverse bets first.** Wire formats, public IDs / routes, data
  shapes / schemas, and auth model are expensive to change later. Pin these
  early and make them prominent (a diagram, a `code` block, a before/after tab).
  Easily-reversible details can stay at low resolution.
- **Keep examples at the right altitude.** Show the load-bearing snippet — the
  signature, the schema, the one behavioral diff — not whole files. A `diff`
  with a `@note:` on the key hunk beats pasting the entire function.
- **Planning is READ-ONLY.** Do not edit source, run migrations, or mutate state
  while planning. The only file you write is `plan.md` (and its rendered HTML).
- **One questions block at the bottom.** Collect every unresolved decision into a
  single `questions` block at the end, each with a recommended `default:` — don't
  scatter "TBD"s through the plan or block on them mid-flow.
- **The plan IS the approval gate.** Present the rendered page and ask for
  sign-off on *it*. Don't render a plan and then separately ask "does this look
  good?" — the page is the thing being approved.

## Workflow

1. **Research (read-only).** Explore the codebase and pin down the real files,
   types, and the hard-to-reverse bets. No source edits.
2. **Write `plan.md`** in the documented format. Frontmatter (`title`,
   `objective`, `status`) plus prose interleaved with fenced blocks: `steps`,
   `filetree`, `diff`, `code`, `diagram`, `wireframe`, `questions`, and
   `tabs` / `collapsible` grouping. **`references/format.md` is the authoritative
   block catalog** — its authoring syntax is the contract with the renderer; do
   not invent block types or attributes. For wireframes, the `.wf-*` class
   catalog and quality bar live in **`references/wireframe.md`**; for diagrams,
   **`references/diagrams.md`** lists which Mermaid type to use and per-type
   syntax. Both are loaded on demand, so they don't cost always-on context.
   Diagrams render **hand-drawn by default** (sketchy + a hand-written font); add
   `look=clean` on a `diagram` for a crisp/technical one. Unknown blocks degrade
   to a labeled `<pre>`, so the `.md` is still readable anywhere.
3. **Render and open:** the renderer lives next to **this `SKILL.md`** at
   `<skill-dir>/renderer/render.mjs`, where `<skill-dir>` is the directory
   containing this file (e.g. `~/.claude/skills/visual-plan` or
   `~/.agents/skills/visual-plan`). Your working directory during research is the
   **user's project root**, NOT the skill dir, so you must invoke the renderer by
   that resolved path — a bare `node renderer/render.mjs …` will fail with
   "Cannot find module". Substitute the actual skill directory you loaded this
   file from:
   ```
   node <skill-dir>/renderer/render.mjs <plan.md> --open
   ```
   Stay in the user's project dir when you run this: the `<plan.md>` input and
   the default/`--out` output are resolved relative to your **current** directory
   (not the skill dir), so a relative `<plan.md>` / `--out` lands in the user's
   project as intended. (If you instead `cd` into `<skill-dir>` first, pass
   absolute paths for `<plan.md>` and `--out`.)
   Add `--lean` for tiny offline files (drops the inlined Mermaid bundle;
   diagrams show as code). Use `--out <path>` to choose the location; default is
   `./.visual-plans/<slug>/index.html`. Omit `--open` to render without
   launching a browser.

   **How `--open` works (and why it always gives you something clickable).** It
   tries the platform's openers (`$BROWSER` → `wslview` → `explorer.exe` →
   `xdg-open`) and — regardless of whether any fired — **always prints two
   targets**:
   ```
   windows: \\wsl.localhost\<distro>\…\index.html   (WSL only)
   url:     file:///…/index.html
   ```
   **Surface that `url:` line (and on WSL the `windows:` path) to the user.** Many
   harnesses/IDEs (Claude Code included) auto-open a surfaced `file://` link; where
   they don't, it's a one-click path. This is why opening still works when the
   native openers can't — e.g. WSL with interop disabled, where `wslview` /
   `explorer.exe` fail but the printed `\\wsl.localhost\…` UNC path opens straight
   from Windows.
4. **Report and request approval.** Give the user the printed **`url:` / Windows
   path** (so they can open it) and a 2–3 line summary of the approach, and ask
   them to review the page and sign off. That review is the gate — proceed to
   implementation only after approval.

## Local & private

The output is a **single self-contained HTML file** — inlined CSS, inlined
vanilla JS for tabs / collapse / theme, (unless `--lean`) an inlined Mermaid
bundle that renders diagrams in the browser, and — when a hand-drawn diagram is
present — the Virgil font **embedded as a base64 data URI**. No CDN, no web-font
fetch, no external URLs: it opens straight from `file://` and works with the
network off. Nothing about your plan or your code ever leaves the machine. The
renderer needs **no `npm install`** — `marked`, `mermaid`, and the font are
vendored.

Note: `wireframe` block bodies are passed through as HTML by design (you author
them, you view them locally) — only render plan files you trust.
