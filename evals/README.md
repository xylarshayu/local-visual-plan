# Evals — the model-behavior layer

`skills/present/renderer/test/` and `share/test/run.mjs` are 192
deterministic, offline unit tests against `render.mjs`, `recap.mjs`,
`github-md.mjs`, `annotate.js`, and the share server — zero flakiness, zero
cost, and they gate every engine change. But `present`, `present-plan`, and
`present-recap` are prompts (`SKILL.md` files), and prompts have a second
failure surface those tests can't see: does the right skill *trigger* on a
real query, does the agent *author* a valid `plan.md`/`recap.md` once it
does, does *feedback ingestion* touch the lines a reviewer actually meant.
`evals/` is a small, zero-dependency harness for that layer: it drives the
real `claude -p` CLI against labeled cases and grades the transcript/output
deterministically — not an LLM judge.

## The three suites

1. **Triggers** (`evals/cases/triggers.json`) — ~60 labeled queries across
   all three skills: does a should-fire query fire the right skill, does a
   near-miss stay quiet. Positives cover formal/casual/competing-skill
   phrasings ("make a visual plan" must fire `present-plan`, not `present`);
   negatives are *strong* near-misses — shared keywords, different intent.
   Easy negatives test nothing.
2. **Authoring** (`evals/cases/behavior.json`, authoring cases) — 2–3
   scenarios per skill against tiny fixture projects: does the agent write a
   `plan.md`/`recap.md` that renders with zero warnings, follows the
   discipline (a `steps` block leading with `reuse`, one `questions` block),
   and passes `check.mjs`.
3. **Ingestion + pressure** (`evals/cases/behavior.json`, ingestion +
   pressure cases) — does a `presentation-feedback v1` round-trip land the
   right edit in the right place (including the hard cases: an unresolvable
   anchor, a docId mismatch), and does the skill hold its discipline under
   superpowers-style pressure ("URGENT, skip the page, start coding").

This file is the doctrine — what to run and why. Case-authoring detail lives
in `evals/cases/triggers.json` / `evals/cases/behavior.json` themselves.

## When to run what

- **Engine change** (`render.mjs`, `recap.mjs`, `check.mjs`, `share/`) → the
  192 deterministic tests. That's the gate. No model runs needed.
- **Any `description:` edit** → the triggers suite for the touched skill.
  Train split while iterating on the wording, validation split once before
  commit. Descriptions gate routing, and this is the regression the
  ecosystem keeps rediscovering — Langfuse reported one word ("optional" vs
  "mandatory") flipping every case in their suite.
- **SKILL.md workflow/body edit** → the relevant behavior suite (authoring
  for a `present`/`present-plan`/`present-recap` workflow change, ingestion
  for a `feedback.md`-adjacent change).
- **Before tagging a release, or updating the skills.sh listing** → a full
  sweep on the haiku+sonnet matrix — `node evals/run.mjs all --matrix` —
  results committed to `evals/results/`.
- **A failure seen in real use** → the RED-GREEN-REFACTOR loop below, not a
  silent SKILL.md patch.

**Default weight for routine runs** (adopted after the first baseline — the
full matrix is a once-per-era measurement, not the everyday tool): routine
re-checks run the **validation split on haiku only** (~$1, a few minutes,
silent — the runner suppresses browser-opening in eval workspaces):
`node evals/run.mjs triggers --split validation --model haiku`. The full
haiku+sonnet matrix is reserved for releases, model upgrades, and re-baselining
after a big skill rework. Every eval invocation prints its cost; if a run
surprises you, stop and reconsider the scope rather than normalizing it.

## Pass criteria (pinned — don't renegotiate per run)

- **Positive trigger case** — passes at rate ≥ 2/3 over 3 runs.
- **Negative trigger case** — fails the suite at a stray-fire rate ≥ 2/3. A
  single stray fire in three (1/3) is a **warning**: recorded, not fatal —
  nondeterminism at that rate is expected.
- **Behavior case** (authoring/ingestion/pressure) — all-or-nothing per case.
  Default `runs: 1`; every assertion must pass.
- `split` (`train`/`validation`) is honored only during description-tuning
  sessions. Validation cases are never used to choose a description — that's
  the entire point of holding them out.

## Cost expectations

Anchors from the research behind this harness: ~$5.59 for a 250-invocation
trigger study. Behavior cases are multi-turn — the agent actually authors a
file or ingests a feedback blob — and cost more per case than a trigger
check. `run.mjs` prints a cost total summed from each invocation's
`total_cost_usd`; read it before kicking off a `--matrix` sweep, not after.

**Never CI-gated.** This matches every surveyed repo, including Anthropic's
own [`anthropics/skills`](https://github.com/anthropics/skills) — no
live-model CI anywhere in the ecosystem, for cost and flakiness reasons.
Runs are manual: at edit time per the rules above, full sweep before a
release. Committed `evals/results/*.json` files carry the regression story
across months without re-running anything.

## The model matrix

`--model <name>` picks one model (default: sonnet — the model users actually
run day to day; haiku for cheap, fast description-tuning loops). `--matrix`
runs a suite across **both** haiku and sonnet.

Why the matrix matters — from review feedback on the plan behind this
harness, and it's exactly right: **a heavy model can out-reason a weak
skill** — brute intelligence papers over a vague description or a mushy
workflow, so a sonnet-only pass rate can look clean while the skill itself is
badly specified. **Haiku's pass rate is the sensitive instrument for skill
quality; sonnet's is the fidelity check for what users actually run.**
Baselines and pre-release sweeps run both — this also matches Anthropic's own
checklist item to test skills across model tiers.

## Portability note

The *skills* already work beyond Claude Code: `install.sh` targets
`~/.agents/skills` for Cursor, Codex, Gemini CLI, OpenCode, and Copilot, and
`SKILL.md` is the cross-vendor open standard
([agentskills.io](https://agentskills.io)). The *eval runner* in v1 drives
`claude -p` only — but the case schema (`evals/cases/*.json`) deliberately
uses agentskills.io field names (`expect_skill`, `split`, …), not
Claude-specific ones, so it's already agent-neutral. A Quorum-style
multi-CLI runner — evaling the same cases against `codex exec` or another
agent CLI — is a natural later extension of the schema, not a rewrite.

## How to add a case

Trigger cases (`evals/cases/triggers.json`):

```json
{ "id": "recap-pos-casual", "query": "what changed on this branch?",
  "expect_skill": "present-recap", "split": "train" }
```

```json
{ "id": "recap-neg-chat", "query": "summarize this diff in one sentence here in chat",
  "expect_skill": null, "split": "validation" }
```

`expect_skill: null` marks a negative — any skill firing is a stray fire.
Give every case an `id` that reads as `<skill>-<pos|neg>-<flavor>` — results
files key on it, and a good id is half the debugging.

Behavior case (`evals/cases/behavior.json`):

```json
{ "id": "ingest-fold-answer", "skill": "present-plan",
  "workspace": "fixtures/ingest-basic", "prompt_file": "prompt.md",
  "runs": 1, "assertions": [
    { "type": "file-absent-text", "file": "plan.md", "text": "# Chunk uploads above 5MB?" },
    { "type": "file-has-text",    "file": "plan.md", "text": "single PUT" },
    { "type": "render-clean",     "file": "plan.md" },
    { "type": "tool-not-used",    "tool": "Edit", "path_prefix": "src/" } ] }
```

Assertion types so far: `file-has-text`, `file-absent-text`, `render-clean`
(imports `renderPlan()` directly — zero warnings required), `check-clean`
(runs `check.mjs` against the rendered output), `tool-used` / `tool-not-used`
(grep the `stream-json` tool-use events, with an optional `path_prefix`),
`reply-mentions` (transcript grep — for pressure cases where the assertion is
"the agent said X out loud"). Start minimal: 2–3 cases per new behavior area,
per agentskills.io's own advice — the schema grows, the runner doesn't
change.

## How to read a results file

`evals/results/<date>-<label>.json` — one file per sweep, committed. Shape:
run metadata (model or matrix, date, suite(s) run) at the top, then one
entry per suite, then one entry per case (`id`, runs, passes, pass rate,
`cost_usd`), then a `totals` block (`total_cost_usd`, cases run, pass/fail
counts by suite). Diff two dated files to see drift — a trigger case that
held at 3/3 for months and now sits at 2/3 is the harness earning its keep,
not noise to ignore.

## The failure-intake loop (RED-GREEN-REFACTOR)

superpowers' loop, applied to routing/authoring/ingestion instead of
discipline rules: **RED** — a failure seen in real use becomes a case first,
reproducing it. **GREEN** — the `SKILL.md` edit that fixes it, re-run until
the case passes. **REFACTOR** — a loophole check: try to make the same
failure happen a different way before calling it closed.

`evals/LEARNINGS.md` is the intake queue feeding that loop, and the ratchet
is deliberate:

- **Observed once** → logged in `LEARNINGS.md`. Not every one-off is worth a
  permanent case — most single observations are noise, already-fixed, or a
  fluke of that particular run.
- **Recurring** → promoted to a case (RED) **and** a `SKILL.md` edit (GREEN).
  The case comes first: write the failing case, watch it fail, edit the
  skill, watch it pass. Editing first and adding a case after only documents
  that you fixed it once — it doesn't prove the fix holds.

See `evals/LEARNINGS.md` for the template and the current queue.
