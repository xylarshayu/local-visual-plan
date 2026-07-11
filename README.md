# local-visual-plan

A **fully-local, no-SaaS presentation engine** for turning any topic — a
codebase, a plan, a diff, a concept, a pile of notes — into a single
**self-contained, interactive HTML file**. One base skill, **present**,
carries the general authoring and rendering craft; two thin workflow
adapters, **present-plan** and **present-recap**, sit on top of it for the two
disciplines that need more than that — getting sign-off on an implementation
plan, and recapping a git diff. All three share one renderer: scannable
steps, annotated diffs and code, file trees, data-model and API-contract
blocks, Mermaid diagrams, UI wireframes, callouts, chapters with a side nav,
before/after tabs, collapsible sections, an open-questions list you can answer
inline, and a click-to-annotate review layer that exports straight back into
the agent.

(These skills were named `visual-plan` / `visual-recap` through 2026-06, then
`presentation-plan` / `presentation-recap` through early 2026-07 — same
engine, renamed twice as the shape of the work clarified: first out from
under BuilderIO's naming, then split so the general capability wasn't trapped
under "plan". `install.sh` retires both prior generations' names on install so
no generation ever double-triggers.)

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

## What's new since v1

- **Interactive questions.** Each open question in a `questions` block renders
  as a form — *Accept default* / *Answer differently* — and leaving the
  pre-selected default in place counts as accepting it.
- **Click-to-annotate review.** Note mode lets you pin a note on any anchored
  element (a step, a diff hunk, a paragraph, a table cell, a whole block),
  marked *for the agent* or *note to self*; **Export** copies a structured
  blob you paste back into the agent, which resolves it to exact `plan.md`
  lines and acts on it.
- **Change highlights on re-render.** When the agent updates the plan and
  re-renders, the new page diffs itself against the version it replaced:
  edited and new elements are highlighted, with a floating ‹ n/m › navigator
  (keys `n`/`p`) and a "Changed in this version" panel list to walk exactly
  what moved.
- **Version history + compare dropdown.** Every re-render prepends the prior
  version's anchor map to a `pf-history` island (capped at 8, newest first);
  the changes navigator gains a version dropdown ("vs v3", "vs v2", …) that
  re-diffs the page against any prior version entirely in the browser.
- **Agent reply threads.** After ingesting an export, the agent re-renders
  with `--replies <file>` — each reply appears as an inline card right at the
  element it answers, plus an "Agent replies" list in the review panel.
- **Text-selection notes.** Select text inside any anchored element to pin a
  note on just that phrase — the selection is highlighted with a `<mark>`,
  and the export's `>` excerpt is the exact selected text.
- **Presenter mode.** Pages with chapters get a *Present* button in the
  floating pill: one chapter at a time, ← → / Space / PageUp/PageDown to
  navigate, Esc to exit, with a clickable chapter progress rail and counter.
- **Review-progress meter.** The pill shows a live review percentage (scroll
  depth, checklist ticks, questions touched, diffs viewed — only the
  components the doc actually has), with per-component bars in the review
  panel.
- **`--watch` mode.** Re-renders on every save and serves the page at a
  loopback-only localhost URL with SSE live reload — the HTML on disk stays
  offline-pure (the reload snippet is injected at serve time only).
- **Chapters + side nav.** `<!-- chapter: Title -->` directives split one file
  into sections with a scrollspy sidebar and deep links — still one HTML file.
- **`callout` block** — `tone=info|decision|warning|risk` — for a decision or
  warning that shouldn't get lost in prose.
- **`data-model` block** — schema entities/fields with `filetree`-style change
  flags (`+ ~ - .`), `was:` old-value annotations, PK/FK badges, and
  Mermaid-ER-style relation lines rendered as a list — for showing *what
  changed* about a schema, which a Mermaid `erDiagram` can't express.
- **`api-endpoint` block** — a method + path badge, flagged param lines
  (`path|query|header|body|auth`), and `request:` / `response <code>:` JSON
  rendered as zero-JS collapsible trees. Both new blocks get field-level
  anchors, so a review note can pin to a single column or query param.
- **Stable anchors + a baked-in source map.** Every heading, paragraph, step,
  diff hunk, and block gets a content-derived id; the page embeds an
  anchor → `plan.md` line-range map plus the `plan.md` source itself, so an
  exported note resolves back to exact lines even without the original file at hand.
- **`check.mjs`** — a best-effort diagram validator: loads the rendered page in
  whatever local headless Chromium it can find and fails, listing captions,
  for any Mermaid diagram that didn't render to SVG; skips cleanly with no
  browser available.
- **Secret redaction (recap).** `recap.mjs` masks token-shaped strings (API
  keys, AWS-style keys, PEM headers, `Authorization:` values) before diff
  content enters a block.
- **Viewed checkboxes (recap).** One per diff tab, persisted, so a large
  multi-file review survives across sittings.

All of the above persists to `localStorage` keyed `pf:<docId>` — see Offline
guarantee below: none of it leaves the machine either.

## Offline / self-contained guarantee

The renderer emits **one `.html` file** with everything inlined: the stylesheet,
the interactivity JS, and (unless `--lean`) the Mermaid bundle. **No external
URLs, no CDN, no web fonts, no network at view time, no server, no account.** It
renders fully offline from `file://` — disconnect your network and it still
works. Dependencies (`marked`, `mermaid`) are **vendored** in
`renderer/vendor/`, so there is **zero `npm install`**. Notes and question
answers you pin in the annotation layer live in the browser's
`localStorage` (or, where that's blocked, in page memory) — Export is the only
way any of it leaves the page, and that's a manual copy/paste you control.

> Trust boundary: `wireframe` block bodies are intentionally passed through as
> HTML (authored by your agent, viewed locally). Do not render plan files from
> untrusted sources.

## Use it

### Via the skill (recommended)

Install (below), then ask your agent to **"present X"** / **"explain this repo
visually"** / **"make me a page about X"** / `/present` for anything you want
to see rather than read as chat text — a codebase, an architecture, an idea,
a concept, a comparison of options.

For an implementation plan you need to sign off on before code is written:
**"make me a presentation plan"** / **"plan this visually"** / `/present-plan`
(the older `/visual-plan` and `/presentation-plan` still describe the same
intent, if that's your muscle memory). The skill researches the codebase
read-only, writes a `plan.md` in the documented format, runs the renderer, and
opens the result — then, once you've pinned notes or answered the open
questions in the page and hit Export, paste the result back and the agent
ingests it (see `skills/present/references/feedback.md`).

For a diff instead of a forward plan: **"recap this PR"** / **"what changed"**
/ `/present-recap` (`/visual-recap` / `/presentation-recap`, formerly).

### Raw renderer

Run from the repo root (the paths below are repo-relative). When a skill is
**installed** (e.g. `~/.claude/skills/present`), invoke the renderer by its
path inside that install dir instead — `node <skill-dir>/renderer/render.mjs …`
— since your shell's cwd is usually the project you're presenting, not the
skill.

```sh
node skills/present/renderer/render.mjs doc.md --open
```

For a diff instead of a forward doc (shares the same engine):

```sh
node skills/present/renderer/recap.mjs [<range>] --open
```

Common flags:

- `--out <path>` — write the HTML somewhere specific.
- `--lean` — drop the inlined Mermaid bundle for a tiny file (diagrams show as
  labeled code blocks instead).
- `--open` / `--no-open` — open the result in the browser (via the opener's
  `$BROWSER` → `wslview` → `explorer.exe` → `xdg-open` fallback chain). Default
  is **not** to open unless `--open` is passed.
- `--replies <path>` — a JSON file of agent replies to reviewer notes
  (`{"replies":[{"anchor":"…","reply":"…","note":"…"?}]}`), shown as inline
  cards at the elements they answer.
- `--watch` — re-render on every save and serve the page at a loopback-only
  localhost URL with SSE live reload (the file on disk stays offline-pure;
  the change-highlight baseline is frozen at watch start).

By default the HTML is written to `./.visual-plans/<slug>/index.html` relative to
the current directory (`<slug>` is the kebab-cased title), falling back to
`/tmp/visual-plans/<slug>/index.html` when the working directory isn't writable.
`.visual-plans/` is gitignored.

There's also a programmatic API:

```js
import { renderPlan } from './skills/present/renderer/render.mjs'
const { html, title, slug, warnings } = renderPlan(markdownSource, { lean: false })
```

## Share it

Every rendered page can get a URL. Two modes, one verb:

- `share.mjs <page>` pushes the HTML to your VM and hands back a durable,
  VPN-scoped `/p/:id` link — paste it into a PR comment.
- `share.mjs <page> --tunnel` skips the VM: serves the file locally and opens
  an ephemeral **public** tunnel (plain `ssh` to a pinggy-style endpoint, no
  account needed) for "look at this now" over Teams, before any PR exists.

### Deploy the store

Same handler core, either mount. Standalone, zero-dependency:

```sh
PRESENT_SHARE_TOKEN=your-secret node share/serve.mjs --port 8787
```

Dropped into an existing fastify server:

```js
import sharePlugin from './share/fastify-plugin.mjs'
app.register(sharePlugin, { token: process.env.PRESENT_SHARE_TOKEN, dir: './share-data' })
```

`PRESENT_SHARE_DIR` (default `./share-data`) holds `manifest.json` plus one
`<id>.html` per share; a daily sweep deletes anything past its TTL. Tokens can
also live in `<dir>/tokens.json` — a label plus a sha256 hash per secret —
instead of one shared `PRESENT_SHARE_TOKEN`. `share/` is infra you deploy
yourself; `install.sh` never touches it. Only `renderer/share.mjs` — the CLI
below — ships with the installed skills, and it's self-contained rather than
importing `share/core.mjs`, since an installed skill dir doesn't carry
`share/` alongside it.

### Use it from the CLI

```sh
node skills/present/renderer/share.mjs .visual-plans/my-plan/index.html --server https://vm.example
node skills/present/renderer/share.mjs .visual-plans/my-plan/index.html --server https://vm.example --pr 482
node skills/present/renderer/share.mjs .visual-plans/my-plan/index.html --tunnel --minutes 30
```

`POST /p` takes a Bearer upload token and the raw `text/html` body, an
optional `?ttl_days=` (default 90, `0` = forever), and caps uploads at 8 MiB
by default (`PRESENT_SHARE_MAX_BYTES`) — `docId`/`title` are lifted straight
from the page's own `pf-anchor-map`, so the store never needs telling what it
received. `GET /p/:id` serves the page back; `GET /healthz` is a liveness
check.

### Security posture

The upload token is the trust boundary — anyone holding it can publish
arbitrary HTML at your VM's origin, so it's hashed at rest, capped in size,
and meant to be rotated by editing one env var (or one `tokens.json` row).
Every served page gets a lock-down CSP — `default-src 'none'; script-src
'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:` —
enforcing the offline promise server-side: inline everything, reach nothing,
so even a hostile wireframe body can't phone home from a reviewer's browser.
Keep viewing inside your VPN, same as today. Tunnel mode trades that away on
purpose: the link is unguessable but public internet for its lifetime;
`share.mjs` prints that warning on every `--tunnel` run and refuses when the
page's title matches `PRESENT_NO_TUNNEL_PATTERN` (a regex you configure for
confidential markers).

### Inline PR fallback

`render.mjs --github` writes a `github.md` next to the output: a degraded
GitHub-flavored rendition — native `mermaid` fences, callouts as GitHub
alerts, wireframes as placeholders — good enough to preview inline in a PR
comment with zero clicks, alongside or instead of the hosted link.

## Install

```sh
./install.sh
```

### Or via the skills CLI

The repo follows the open [Agent Skills](https://agentskills.io) layout, so
the [skills.sh](https://skills.sh) CLI works too:

```sh
npx skills add xylarshayu/local-visual-plan            # all three skills
npx skills add xylarshayu/local-visual-plan -s present # just the base
```

Note for CLI installs: `present-plan` and `present-recap` are thin adapters —
install them **alongside `present`** (the default all-three install does
this). They resolve the shared engine from the sibling `present` install;
`./install.sh` instead copies the engine into each skill, so either path
yields working skills.

### What install.sh does

Idempotent — re-run any time to update. It installs **all three** skills into
each agent skill dir, first removing installs from both prior name
generations (`visual-plan`, `visual-recap`, `presentation-plan`,
`presentation-recap`) so no generation ever double-triggers:

- `present/` — the base skill; `renderer/` and `references/` live here
  natively, so the install is fully self-sufficient.
- `present-plan/` — its own `SKILL.md`, plus a copy of `present`'s
  `renderer/` and `references/` (each adapter gets its own copy so it never
  depends on `present` also being installed).
- `present-recap/` — same treatment: its own `SKILL.md`, its own copy of the
  engine.

Targets:

- `~/.claude/skills/` — Claude Code
- `~/.agents/skills/` — shared path for Codex, Gemini CLI, Cursor, OpenCode,
  Copilot

The script resolves its own location, so you can run it from anywhere. If it ever
loses its executable bit: `chmod +x install.sh` (or run `sh install.sh`).

## Evals

`skills/present/renderer/test/` and `share/test/run.mjs` are 192
deterministic, offline unit tests against the renderer, recap collector, and
share server — they gate every engine change. `SKILL.md` files are prompts,
though, and prompts have a failure surface those tests can't see: does the
right skill trigger on a real query, does the agent author a valid
`plan.md`, does a feedback round-trip land the right edit. `evals/` is a
small, zero-dependency harness for that layer — it drives the real
`claude -p` CLI against labeled cases and grades the output deterministically
(the renderer is the grader), not an LLM judge.

Three suites, one sentence each: **triggers** — does a query fire the right
skill and stay quiet on near-misses; **authoring** — does the agent write a
`plan.md`/recap that renders clean against tiny fixture projects;
**ingestion + pressure** — does a feedback round-trip land in the right
place, and does the skill hold its discipline under time/authority pressure.
`node evals/run.mjs all --matrix` is the canonical pre-release sweep (haiku +
sonnet, all three suites, results committed to `evals/results/`) — it's never
CI-gated, same as every surveyed repo. See
[`evals/README.md`](evals/README.md) for when to run what, pass criteria,
and how to add a case.

## Repo layout

```
local-visual-plan/
  skills/
    present/
      SKILL.md                     # base skill: general authoring/render/feedback craft
      references/
        format.md                  # authoritative block contract (author <-> renderer); incl. data-model, api-endpoint
        wireframe.md                # wireframe authoring + .wf-* CSS class catalog
        diagrams.md                 # which Mermaid diagram type to use, per-type syntax
        feedback.md                 # presentation-feedback v2: export grammar + ingestion algorithm
      renderer/
        render.mjs                 # CLI + programmatic renderer (Node ESM, zero npm install)
        recap.mjs                  # diff collector -> plan-shaped markdown; feeds render.mjs
        github-md.mjs              # render.mjs --github: degraded GitHub-flavored rendition (mermaid fences, alert callouts)
        share.mjs                  # CLI: push a rendered page to a share server, or --tunnel for an ephemeral public link
        open.mjs                   # browser opener (used by --open)
        check.mjs                  # best-effort post-render Mermaid validator (headless Chromium)
        template.html               # output document shell
        styles.css                  # inlined design system
        annotate.css                # inlined: pins, composer, review panel, print rules
        interactivity.js            # inlined vanilla JS (tabs, collapse, theme, mermaid init, scrollspy)
        annotate.js                 # inlined vanilla JS: note mode, composer, review panel, export
        vendor/
          marked.esm.js             # vendored Markdown parser (MIT)
          mermaid.min.js             # vendored; runs client-side in the output HTML
        test/{fixtures,run.mjs,recap-run.mjs,annotate.mjs}
    present-plan/
      SKILL.md                     # thin adapter: planning discipline + workflow; installed copies also get renderer/ + references/
    present-recap/
      SKILL.md                     # thin adapter: recap workflow; installed copies also get renderer/ + references/
  share/
    core.mjs                       # zero-dep store + handlers: token auth, size cap, docId/title lift, manifest, TTL sweep
    serve.mjs                      # standalone node:http mount for a bare VM
    fastify-plugin.mjs             # thin fastify wrapper over the same core, for an existing server
    test/run.mjs                   # zero-dep: token auth, size cap, docId lifting, TTL expiry, manifest round-trip, CSP header
  evals/
    run.mjs                       # zero-dep runner: workspace isolation, stream-json parsing, graders, cost accounting
    cases/
      triggers.json               # ~60 labeled queries across the three skills, train/validation split
      behavior.json               # authoring + ingestion + pressure cases, code-graded assertions
    fixtures/                     # tiny fixture projects + seeded plan.md/export blobs the behavior cases run against
    results/                      # committed run outputs, <date>-<label>.json (cost + pass/fail per case)
    README.md                     # the doctrine: what each suite measures, when to run what, cost, how to add a case
    LEARNINGS.md                  # observed-failure intake feeding the RED-GREEN-REFACTOR ratchet
  docs/superpowers/specs/
    2026-06-20-local-visual-plan-design.md      # the original engine design
    2026-07-03-presentation-upgrade-design.md   # the annotation/chapters/callout upgrade + three-skill restructure addendum
  install.sh
  README.md
```

The renderer lives **inside** `skills/present/` on purpose: the dev layout and
the installed layout are identical, so `SKILL.md` always references the
renderer at the stable relative path `renderer/render.mjs`. `present-plan`
and `present-recap` don't keep their own copy of the engine in this repo —
`install.sh` copies `present`'s `renderer/` and `references/` into each at
install time, and their `SKILL.md` paths (`<skill-dir>/renderer/…`,
`<skill-dir>/references/…`) assume that installed layout.

## License

MIT — see [`LICENSE`](LICENSE). Vendored components (`marked`, Mermaid, the
Virgil font) remain under their own licenses, enumerated in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Credits & inspiration

This project was inspired by
[BuilderIO/skills](https://github.com/BuilderIO/skills) — specifically their
`visual-plan` and `visual-recap` skills, whose presentation quality and
planning discipline (research-first, lead-with-reuse, decide hard-to-reverse
bets first, a single open-questions block) set the bar. The planning discipline
here is adapted from that work; the renderer and everything it emits are an
independent, fully-local implementation.

## More detail

- **Design specs:**
  - [`docs/superpowers/specs/2026-06-20-local-visual-plan-design.md`](docs/superpowers/specs/2026-06-20-local-visual-plan-design.md) — the original engine.
  - [`docs/superpowers/specs/2026-07-03-presentation-upgrade-design.md`](docs/superpowers/specs/2026-07-03-presentation-upgrade-design.md) — the annotation/chapters/callout upgrade, plus a 2026-07-04 addendum on the three-skill restructure and the `data-model`/`api-endpoint` blocks.
- **Format contract** (the source of truth for every block's authoring
  syntax and output HTML): [`skills/present/references/format.md`](skills/present/references/format.md)
- **Feedback contract** (the export grammar + ingestion algorithm for the
  annotation round-trip): [`skills/present/references/feedback.md`](skills/present/references/feedback.md)
</content>
