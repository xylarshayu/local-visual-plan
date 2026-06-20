# local-visual-plan

A **fully-local, no-SaaS visual plan renderer.** It turns a plan written in
Markdown (`plan.md`) into a single **self-contained, interactive HTML file** that
opens in your browser — scannable steps, annotated diffs and code, file trees,
Mermaid diagrams, UI wireframes, before/after tabs, collapsible sections, and an
open-questions list.

## Why

BuilderIO's `visual-plan` / `visual-recap` skills nail the *presentation* of an
agent's plan, but they're a thin client for a hosted service: the default mode
ships your plan and diff content to their servers, "local-files" mode still
renders by loading their hosted web app (needs internet + their domain), and
"self-hosted" means standing up a full Nitro + Drizzle + Cloudflare + Expo stack
with a database.

This project keeps the genuinely-good part — the high-fidelity *viewing*
experience and the planning discipline (research-first, lead-with-reuse, decide
hard-to-reverse bets first, a single open-questions block) — and drops the
hosted dependency entirely.

## Offline / self-contained guarantee

The renderer emits **one `.html` file** with everything inlined: the stylesheet,
the interactivity JS, and (unless `--lean`) the Mermaid bundle. **No external
URLs, no CDN, no web fonts, no network at view time, no server, no account.** It
renders fully offline from `file://` — disconnect your network and it still
works. Dependencies (`marked`, `mermaid`) are **vendored** in
`renderer/vendor/`, so there is **zero `npm install`**.

> Trust boundary: `wireframe` block bodies are intentionally passed through as
> HTML (authored by your agent, viewed locally). Do not render plan files from
> untrusted sources.

## Use it

### Via the skill (recommended)

Install (below), then ask your agent to **"make me a visual plan"** /
**"plan this visually"** / `/visual-plan`. The skill researches the codebase
read-only, writes a `plan.md` in the documented format, runs the renderer, and
opens the result.

### Raw renderer

Run from the repo root (the path below is repo-relative). When the skill is
**installed** (e.g. `~/.claude/skills/visual-plan`), invoke the renderer by its
path inside that install dir instead — `node <skill-dir>/renderer/render.mjs …`
— since your shell's cwd is usually the project you're planning, not the skill.

```sh
node skills/visual-plan/renderer/render.mjs plan.md --open
```

Common flags:

- `--out <path>` — write the HTML somewhere specific.
- `--lean` — drop the inlined Mermaid bundle for a tiny file (diagrams show as
  labeled code blocks instead).
- `--open` / `--no-open` — open the result in the browser (via the opener's
  `$BROWSER` → `wslview` → `explorer.exe` → `xdg-open` fallback chain). Default
  is **not** to open unless `--open` is passed.

By default the HTML is written to `./.visual-plans/<slug>/index.html` relative to
the current directory (`<slug>` is the kebab-cased title), falling back to
`/tmp/visual-plans/<slug>/index.html` when the working directory isn't writable.
`.visual-plans/` is gitignored.

There's also a programmatic API:

```js
import { renderPlan } from './skills/visual-plan/renderer/render.mjs'
const { html, title, slug, warnings } = renderPlan(markdownSource, { lean: false })
```

## Install

```sh
./install.sh
```

Idempotent — re-run any time to update. It recursively copies
`skills/visual-plan/` (renderer, references, and `SKILL.md`, all of it) into both
agent skill directories, so each installed copy is fully self-sufficient:

- `~/.claude/skills/visual-plan/` — Claude Code
- `~/.agents/skills/visual-plan/` — shared path for Codex, Gemini CLI, Cursor,
  OpenCode, Copilot

The script resolves its own location, so you can run it from anywhere. If it ever
loses its executable bit: `chmod +x install.sh` (or run `sh install.sh`).

## Repo layout

```
local-visual-plan/
  skills/visual-plan/
    SKILL.md                     # triggers + behavior; documents the format/quality bar
    references/
      format.md                  # authoritative plan.md block contract (author <-> renderer)
      wireframe.md               # wireframe authoring + .wf-* CSS class catalog
    renderer/
      render.mjs                 # CLI + programmatic renderer (Node ESM, zero npm install)
      open.mjs                   # browser opener (used by --open)
      template.html              # output document shell
      styles.css                 # inlined design system
      interactivity.js           # inlined vanilla JS (tabs, collapse, theme, mermaid init)
      vendor/
        marked.esm.js            # vendored Markdown parser (MIT)
        mermaid.min.js           # vendored; runs client-side in the output HTML
      test/{fixtures,golden,run.mjs}
  docs/superpowers/specs/
    2026-06-20-local-visual-plan-design.md   # the design spec
  install.sh
  README.md
```

The renderer lives **inside** the skill folder on purpose: the dev layout and the
installed layout are identical, so `SKILL.md` always references the renderer at
the stable relative path `renderer/render.mjs`.

## More detail

- **Design spec:** [`docs/superpowers/specs/2026-06-20-local-visual-plan-design.md`](docs/superpowers/specs/2026-06-20-local-visual-plan-design.md)
- **Plan format contract** (the source of truth for every block's authoring
  syntax and output HTML): [`skills/visual-plan/references/format.md`](skills/visual-plan/references/format.md)
