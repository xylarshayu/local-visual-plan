---
name: visual-recap
description: Turn a git diff — a branch, a commit range, a PR, or the working tree — into one self-contained, interactive HTML recap you can review locally: a file tree of what changed plus the key per-file diffs (and optional diagrams / wireframes for architecture and UI changes). Use when the user says "recap this PR / branch / commit", "show me what changed", "summarize this diff", "/visual-recap". Renders fully offline from file:// — no SaaS, no account, no network at view time.
---

# Visual Recap

A recap is a visual plan built **from** a diff instead of toward one: instead of
describing the change you are about to make, you describe the change that was
just made, one altitude above line-by-line review. It uses the SAME renderer as
`visual-plan` — `data-model`/`api-endpoint`/`file-tree`/`diff`/`diagram` blocks
that summarize work that already exists. Everything stays local.

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
node <skill-dir>/renderer/recap.mjs [<range>] [--open] [--lean] [--max-files N]
```

- **no range** → working tree + index vs `HEAD` (includes untracked files).
- **`base..head`** → a branch or PR (e.g. `main..feature-x`, or the PR's base..head).
- **single `<ref>`** → that ref compared to the working tree.
- **`--staged`** → only staged changes.

It writes `index.html` (and the generated `recap.md` beside it) and, with
`--open`, opens it. The recap carries a `file-tree` of every changed file and a
`## Key changes` tab strip with the highest-churn files' split diffs.

## Richer recaps — enrich before rendering

For a substantial change, the mechanical diff is a starting point, not the whole
story. Read the generated `recap.md`, then enrich it before the final render:

- **Recap the whole work unit.** When invoked mid-thread, scope to everything the
  thread changed (implementation + fixes + tests), not just the last edit. Use a
  `base..head` range that covers it.
- **Lead with a short narrative** (1–3 sentences of prose): what changed and why,
  and any real compatibility risk — only if it says something the blocks do not.
  Keep the body lean; do not add boilerplate ("this is an aid, still review the
  diff", file counts) — the title, objective, and file-tree already carry that.
- **UI impact needs wireframes.** If the diff changes rendered UI, add `wireframe`
  blocks (see `references/wireframe.md`) — the changed entry surface, the
  interaction that opens, and the resulting state; a `Before`/`After` pair via
  tabs when comparison helps. Ground them in the diff's real components/labels.
- **Architecture / schema / API changes** deserve a `diagram`, `data-model`, or
  `api-endpoint` block so the contract is visible above the line diff.

`references/format.md` is the authoritative block catalog. To re-render an
enriched `recap.md`, run the plan renderer on it:
`node <skill-dir>/renderer/render.mjs <recap.md> --open`.

## Report and review

Give the user the output **path** and a 2–3 line summary of the change, and let
them review the page. Everything is a single self-contained HTML file — inlined
CSS/JS and (unless `--lean`) the mermaid bundle — that opens straight from
`file://` with the network off. Nothing about the diff leaves the machine.
