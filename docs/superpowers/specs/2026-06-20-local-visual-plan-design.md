# Local Visual Plan — Design

- **Date:** 2026-06-20
- **Status:** Approved (pending spec review)
- **Owner:** Ayush Wardhan

## 1. Problem

The agent's plans (and, later, change recaps) are valuable but get buried in chat
as flat text. BuilderIO's `visual-plan` / `visual-recap` skills solve the
*presentation* problem beautifully — scannable, structured, interactive plan
pages — but they are a thin client for a hosted SaaS (`plan.agent-native.com`):

- Default ("hosted") mode ships plan/diff **content** to Builder's servers.
- "Local-files" mode keeps content local but still **renders by loading
  Builder's hosted web app** in the browser (needs internet + their domain).
- "Self-hosted" mode means standing up their full framework (Nitro + Drizzle +
  Cloudflare Workers + Expo monorepo) **with a database** — significant setup,
  and the repo currently ships **no LICENSE file** despite the "open-source"
  label, so forking is legally murky.

We want the *viewing* experience at high fidelity, **fully local**: no SaaS, no
account, no server, no network at view time, nothing leaving the machine.

## 2. Goals / Non-goals

### Goals
- A skill that turns a plan into a **single self-contained, interactive HTML
  file**, rendered fully locally and opened in the browser.
- High-fidelity blocks: ordered steps with files-touched, file-tree with change
  flags, annotated diffs, annotated code, flow/architecture diagrams,
  **wireframe mockups**, before/after, tabs, collapsible sections, open
  questions.
- Carry over the genuinely-good **planning discipline** from BuilderIO's
  MIT-licensed `BuilderIO/skills` repo (research-first, lead-with-reuse, decide
  hard-to-reverse bets first, single open-questions block, right altitude).
- Zero `npm install` to run: dependencies (`marked`, `mermaid`) are **vendored**.
- Works on this WSL2 setup out of the box (`wslview` opener).

### Non-goals (the SaaS part — explicitly out of scope)
- Comment threads anchored to elements; the agent ingesting inline comments.
- Real-time multiplayer / co-editing.
- Live interactive prototype or design-editor surfaces.
- Server-side persistence, sharing links, accounts, hosted history.

## 3. Format decision: `plan.md`, not MDX

Authoring format is **Markdown + a small set of fenced blocks** (`plan.md`),
**not** MDX. Rationale:

- MDX compiles to a JS/React module and needs a compiler + component runtime to
  render — re-introducing the exact heavy, ecosystem-coupled toolchain we are
  avoiding.
- GitHub does **not** render `.mdx` (shows raw source; no rich-diff toggle;
  PR comments are sanitized GFM only). `.md` renders, and GitHub renders
  ` ```mermaid ` natively in files **and** PR comments.
- `.md` **degrades gracefully** — readable anywhere even without our renderer;
  custom blocks appear as labeled code blocks.
- Our fenced blocks are the compiler-free equivalent of MDX component blocks:
  same structured benefit, parsed by a small Node script instead of React.

## 4. Architecture

Four units, each independently understandable/testable:

### 4.1 The skill (`skills/visual-plan/`)
`SKILL.md` + `references/`. Triggers on "plan this visually / make me a visual
plan / `/visual-plan`". Behavior:
1. Research the codebase **read-only** (no source edits during planning).
2. Write `plan.md` in the documented format.
3. Run the renderer (`node renderer/render.mjs <plan.md>`).
4. Open the produced HTML (`wslview`) and report the path + a short summary.

The skill **documents the plan format and the quality bar**; it does not embed
rendering logic. References: `references/format.md` (block catalog) and
`references/wireframe.md` (wireframe authoring + CSS classes).

### 4.2 Plan source format (`plan.md`)
- **Frontmatter:** `title`, `objective`, `status`.
- **Body:** standard Markdown + fenced blocks identified by an info-string:
  - `steps` — ordered steps; each: title, `files:` list (each tagged
    `reuse`/`new`/`edit`), and rationale.
  - `filetree` — file map; each entry has a change flag
    (`added`/`modified`/`deleted`/`unchanged`).
  - `diff` — unified or split diff; optional per-hunk `# @note:` annotations.
  - `code` — annotated snippet: `lang`, optional highlighted line ranges, notes.
  - `diagram` — Mermaid source (flowchart/sequence/ER/etc.).
  - `wireframe` — constrained HTML using documented wireframe CSS classes;
    attributes for `surface` (page/panel/popover/etc.) and clean/sketchy.
  - `questions` — open questions, each with a recommended default.
  - `tabs` / `collapsible` — grouping wrappers (e.g. key-change diffs as tabs).
- Unknown blocks render as labeled `<pre>` (forward-compatible).

The exact block grammar lives in `references/format.md` and is the contract
between the skill (author) and the renderer (consumer).

### 4.3 The renderer (`renderer/render.mjs`)
- Node ESM script, **no `npm install`**. Vendored libs in `renderer/vendor/`:
  - `marked.min.js` (MIT) — Markdown → HTML for prose.
  - `mermaid.min.js` — runs **client-side** in the output HTML (diagrams render
    in the browser on load, from inlined sources).
- Pipeline: read `plan.md` → split frontmatter / markdown / fenced blocks →
  render each block to HTML via dedicated renderers → inject into
  `template.html` with inlined `styles.css` + interactivity JS → write **one
  self-contained `.html`**.
- Flags: `--lean` (drop Mermaid for tiny offline files; diagrams shown as code),
  `--out <path>`, `--open` (invoke opener), `--no-open`.
- Output default: `./.visual-plans/<slug>/index.html` inside a project
  (gitignored), or `/tmp/visual-plans/<slug>/index.html` when not in a project.

### 4.4 The opener (`renderer/open.mjs`, used by `--open`)
Fallback chain: `$BROWSER` → `wslview` → `explorer.exe` (via `wslpath -w`) →
`xdg-open`. On this machine `$BROWSER=wslview` resolves immediately.

## 5. The design system (`renderer/template.html`, `styles.css`)
- A single inlined stylesheet defining the plan-page look: header (title +
  objective + status pill), step cards, file-tree, diff (split/unified) with
  add/remove coloring, annotated-code, diagram frames, **wireframe surfaces**
  (page/panel/popover chrome, clean vs. sketchy outline style), tabs,
  collapsibles, open-questions list.
- Minimal vanilla JS (inlined): tab switching, collapse/expand, theme
  (light/dark), Mermaid init. No framework.
- Wireframe v1 = **constrained HTML + CSS classes** (e.g. `.wf-screen`,
  `.wf-toolbar`, `.wf-row`, `.wf-btn`), not a bespoke DSL — high fidelity, low
  renderer complexity. Visual style inspired by (not copied from) BuilderIO's
  `wireframe.md`.

## 6. Repo layout

The renderer lives **inside** the skill folder so the dev layout and the
installed layout are identical and `SKILL.md` always references the renderer at
the stable relative path `renderer/render.mjs`.
```
local-visual-plan/
  skills/visual-plan/
    SKILL.md
    references/format.md
    references/wireframe.md
    renderer/
      render.mjs
      open.mjs
      template.html
      styles.css
      interactivity.js
      vendor/marked.min.js
      vendor/mermaid.min.js
      test/{fixtures,golden,run.mjs}
  docs/superpowers/specs/2026-06-20-local-visual-plan-design.md
  install.sh
  README.md
```
`install.sh` then just recursively copies `skills/visual-plan/` into each target
skill dir — renderer, references, and all.

## 7. Install
`install.sh` copies the skill into each target, with the `renderer/` directory
copied **inside** the skill folder (`skills/visual-plan/renderer/`) so the
installed skill is fully self-sufficient and references the renderer by a path
relative to `SKILL.md` — no dependency on this dev repo's location. Targets:
- `~/.claude/skills/visual-plan/` (Claude Code)
- `~/.agents/skills/visual-plan/` (shared path → Codex, Gemini CLI, Cursor,
  OpenCode, Copilot)

`install.sh` is idempotent — re-run to update; it overwrites the installed
copies from this repo.

## 8. Testing
- `renderer/test/run.mjs`: render each fixture `plan.md` and assert the output
  HTML contains expected structural markers (golden-ish, tolerant of
  whitespace). Zero-dep (Node's built-in assert).
- Fixtures cover: every block type, unknown-block fallback, `--lean` mode, a
  full realistic plan, an empty/edge plan.
- Manual smoke: render a sample and open it; verify diagrams, tabs, collapse,
  wireframes, and dark/light all work offline (disconnect network to confirm).

## 9. Scope

### v1
`visual-plan` end to end: skill + format + renderer + design system + opener +
install + tests, with all blocks in §4.2.

### Fast-follow (not v1)
`visual-recap`: the **same renderer** fed a git diff instead of a forward plan
(collect diff → map to `filetree` + `diff` + `diagram` blocks). Near-free once
the engine exists. A `--lean` `.md` recap can render diagrams directly in a
GitHub PR comment with no hosting.

## 10. Open questions
None blocking. Deferred decisions: whether to also emit a portable single-file
export for sharing (current default is already self-contained), and whether to
add a `visual-recap` GitHub Action later (depends on the fast-follow).
