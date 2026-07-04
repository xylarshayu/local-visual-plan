---
name: present-recap
description: Turn a git diff — a branch, a commit range, a PR, or the working tree — into one self-contained, interactive HTML recap you can review locally: a file tree of what changed plus the key per-file diffs (each with a Viewed checkbox), optional diagrams / wireframes / data-model / api-endpoint blocks for schema and API changes, and callouts for anything risky. Builds on the `present` base skill (install it alongside) for the general authoring, rendering, and feedback mechanics. Use when the user says "recap this PR / branch / commit", "show me what changed", "what changed", "summarize this diff", "/present-recap" (legacy: "/visual-recap"). Also use when the user pastes a blob starting `<!-- presentation-feedback v1 -->`: that's exported review feedback from a page you rendered earlier, not new prose — resolve it against `<skill-dir>/references/feedback.md`. Secrets are masked automatically at collection. Renders fully offline from file:// — no SaaS, no account, no network at view time.
license: MIT — see LICENSE and THIRD_PARTY_NOTICES.md
---

# Present: Recap

Builds on the `present` base skill — all of its authoring craft, block
catalog, render mechanics, and feedback round-trip apply here unchanged.
**Engine resolution:** use `<skill-dir>/renderer` and `<skill-dir>/references`
when they exist (this repo's `install.sh` copies the engine into each skill).
When this skill was installed by a skills CLI (e.g. `npx skills add`), the
folder carries only this file — use the sibling base install instead:
`../present/renderer` and `../present/references` relative to this skill's
directory (skills install side by side; `present` must be installed
alongside). A recap is a presentation built **from** a diff instead of toward
one: instead of describing a change you're about to make, you describe the
change that was just made, one altitude above line-by-line review.

## When to use it

Recap a PR or commit that is large, multi-file, or touches schema / API
contracts / architecture, so a reviewer can see the shape of the change before
the raw diff. **Skip it** for a tiny, single-file, obvious diff — that reviews
faster as plain `git diff`.

## Fast path — generate from the diff

`recap.mjs` (next to this skill at `<skill-dir>/renderer/recap.mjs`) collects a
git diff and renders it. Your cwd is the user's repo (NOT the skill dir), so
invoke it by the resolved skill path:

```
node <skill-dir>/renderer/recap.mjs [<range>] [--open] [--lean] [--staged] [--max-files N]
```

- **no range** → working tree + index vs `HEAD` (includes untracked files).
- **`base..head`** → a branch or PR (e.g. `main..feature-x`, or the PR's
  base..head).
- **single `<ref>`** → that ref compared to the working tree.
- **`--staged`** → only staged changes.

It writes `index.html` (and the generated `recap.md` beside it) and, with
`--open`, opens it — surface the printed `url:` / Windows path, per the base
skill's render mechanics. The recap carries a `filetree` of every changed file
and a `## Key changes` tab strip with the highest-churn files' split diffs,
each tab with a **Viewed** checkbox (persisted like everything else) so
reviewing a large multi-file change across sittings doesn't lose your place.

**Budgets.** Default 8 diff tabs (`--max-files` to raise or lower it), 220
lines per file before truncation (a `@note:` marks the cut) — enough to show
the shape of a big change without the page becoming the diff it summarizes.

**Secret redaction.** `recap.mjs` masks token-shaped strings (API keys,
AWS-style keys, PEM headers, `Authorization:` values) before diff content ever
enters a block, so neither `recap.md` nor the rendered HTML holds a live
secret. Best-effort pattern matching, not a guarantee — still eyeball diffs of
`.env`-ish or credentials-adjacent files yourself.

## Richer recaps — enrich before rendering

For a substantial change, the mechanical diff is a starting point, not the
whole story. Read the generated `recap.md`, then enrich it before the final
render:

- **Recap the whole work unit.** When invoked mid-thread, scope to everything
  the thread changed (implementation + fixes + tests), not just the last
  edit. Use a `base..head` range that covers it.
- **Stay grounded in the real diff.** The `filetree` and `diff` blocks are
  built mechanically from the actual diff — only the prose (the narrative,
  the callouts, what a diagram or data-model depicts) is yours. Don't
  editorialize a diff or data-model block into showing a change that didn't
  happen.
- **Lead with a short narrative** (1–3 sentences): what changed and why, and
  any real compatibility risk — only if it says something the blocks do not.
  Keep the body lean; the title, objective, and file-tree already carry the
  boilerplate.
- **UI impact needs wireframes.** If the diff changes rendered UI, add
  `wireframe` blocks (`references/wireframe.md`) — the changed entry surface,
  the interaction that opens, and the resulting state; a Before/After pair via
  tabs when comparison helps. Ground them in the diff's real components/labels.
- **Schema or API-contract changes deserve a `data-model` / `api-endpoint`
  block.** `data-model` shows added/changed/removed fields (with `was:`
  values) on the entities touched; `api-endpoint` shows a changed
  request/response shape as a collapsible tree. Either beats a Mermaid
  `erDiagram` when the *change*, not just the current shape, is the point —
  full syntax in `references/format.md`.
- **Architecture** deserves a `diagram` (`sequenceDiagram` / `flowchart` for a
  request path) or a `callout tone=risk` / `tone=decision` above the line
  diff.

To re-render an enriched `recap.md`, run the base renderer on it, then check
it:
```
node <skill-dir>/renderer/render.mjs recap.md --open
node <skill-dir>/renderer/check.mjs <output.html>
```

## Feedback and reporting

Same round-trip as the base skill: note mode, Viewed checkboxes per diff tab,
a Review panel, Export. On a `presentation-feedback` paste, resolve it against
`<skill-dir>/references/feedback.md` — for a recap this is usually a code
change, not a plan edit, so most notes and answers turn into edits, not prose.
Give the user the output path and a 2–3 line summary and let them review;
nothing about the diff leaves the machine unless you share it (below).

## Sharing the recap

If `PRESENT_SHARE_URL` is set, share is the natural last step:
`node <skill-dir>/renderer/share.mjs index.html --server $PRESENT_SHARE_URL --pr <n>`
posts the hosted link straight to the PR thread via `gh`. `--tunnel` gets an
instant public link before a PR exists — relay its public-link warning;
`render.mjs --github` gives the PR an inline markdown fallback. Same feedback
round-trip either way, hosted or local.
</content>
