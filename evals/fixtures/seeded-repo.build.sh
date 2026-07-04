#!/bin/sh
# seeded-repo.build.sh — materializes evals/fixtures/seeded-repo/, a tiny real
# git repo used by the present-recap authoring eval case.
#
# WHY THIS IS A BUILD SCRIPT AND NOT A CHECKED-IN DIRECTORY:
# seeded-repo/ needs a real .git directory (recap.mjs shells out to `git`), but
# a nested .git inside this outer repo is NOT something git tolerates quietly.
# Verified empirically (2026-07-04): `git add -A` on an outer repo containing a
# nested repo stages it as an embedded gitlink (mode 160000) with a loud
# warning ("adding embedded git repository") — and a plain `git clone` of the
# outer repo would silently produce an EMPTY seeded-repo/ directory (no .git,
# no files), because gitlinks point at a commit hash, not content. Checking in
# the built directory would either corrupt the outer repo's history or (more
# likely) silently ship a broken fixture to the next clone. So: only this
# script is committed. `evals/fixtures/.gitignore` excludes the built
# `seeded-repo/` directory so an accidental `git add -A` can't re-trigger the
# problem this script exists to avoid.
#
# Usage:
#   sh evals/fixtures/seeded-repo.build.sh
#
# Idempotent: safe to re-run any time (e.g. after a `git clean`, or to pick up
# an edit to this script) — it deletes and rebuilds seeded-repo/ from scratch
# every time. Author/committer dates and identity are pinned so re-running
# produces byte-identical commits (verified: two consecutive runs produce the
# same commit hash and an empty `git diff` between the two working trees).
#
# What it produces: one base commit (a tiny Node "notifier" service) on branch
# `main`, then three files edited + one new line added *in the working tree,
# left UNCOMMITTED* — so `git diff` (recap.mjs's default "no range" mode:
# working tree + index vs HEAD) surfaces them. One of those edits plants a
# fake-but-realistic-looking API key in `.env.example`, for the
# authoring-recap-seeded-secret eval case to confirm recap.mjs's secret
# redaction actually fires before that content ever reaches recap.md/index.html.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO="$SCRIPT_DIR/seeded-repo"

rm -rf "$REPO"
mkdir -p "$REPO/src"
cd "$REPO"

git init -q -b main
# Repo-local identity + no gpg signing — this is disposable fixture data, not
# a real commit history; never touches the outer repo's git config.
git config user.name "Eval Fixture"
git config user.email "eval-fixture@example.invalid"
git config commit.gpgsign false

# ── base commit ──────────────────────────────────────────────────────────────
cat > package.json <<'EOF'
{
  "name": "toy-notifier",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Tiny notification service used as an eval fixture."
}
EOF

cat > src/config.mjs <<'EOF'
// src/config.mjs — loads configuration from environment variables.
export const config = {
  port: process.env.PORT || 4000,
  smtpHost: process.env.SMTP_HOST || "localhost",
};
EOF

cat > src/index.mjs <<'EOF'
// src/index.mjs — sends a notification when called. Logs instead of actually
// talking to SMTP — this is a fixture, not a real mailer.
import { config } from "./config.mjs";

export function notify(to, subject) {
  console.log(`[notify] to=${to} subject=${JSON.stringify(subject)} via ${config.smtpHost}:${config.port}`);
}
EOF

cat > .env.example <<'EOF'
PORT=4000
SMTP_HOST=localhost
EOF

cat > README.md <<'EOF'
# toy-notifier

A tiny notification service used as an eval fixture. Configure via `.env`
(see `.env.example`); nothing here talks to a real SMTP server.

## Files

- `src/index.mjs` — the `notify()` entry point.
- `src/config.mjs` — environment-driven configuration.
- `.env.example` — documented environment variables.
EOF

# `prompt.md` is eval-runner bookkeeping (the message fed to the agent under
# test), not part of the "codebase" being recapped — gitignored inside this
# inner repo so it never shows up as an untracked/added file in the recap.
cat > .gitignore <<'EOF'
prompt.md
EOF

git add package.json src/config.mjs src/index.mjs .env.example README.md .gitignore
GIT_AUTHOR_NAME="Eval Fixture" GIT_AUTHOR_EMAIL="eval-fixture@example.invalid" \
GIT_COMMITTER_NAME="Eval Fixture" GIT_COMMITTER_EMAIL="eval-fixture@example.invalid" \
GIT_AUTHOR_DATE="2026-01-01T00:00:00+00:00" GIT_COMMITTER_DATE="2026-01-01T00:00:00+00:00" \
  git commit -q -m "Base version of the toy notifier"

# ── working-tree edits, left UNCOMMITTED on purpose ─────────────────────────
# This is what recap.mjs's default (no-range) invocation will diff against
# HEAD. Four files touched: a new env var wired through config + index, the
# README documenting it, and the planted fake secret.

cat > src/config.mjs <<'EOF'
// src/config.mjs — loads configuration from environment variables.
export const config = {
  port: process.env.PORT || 4000,
  smtpHost: process.env.SMTP_HOST || "localhost",
  apiKey: process.env.API_KEY || "",
};
EOF

cat > src/index.mjs <<'EOF'
// src/index.mjs — sends a notification when called. Logs instead of actually
// talking to SMTP — this is a fixture, not a real mailer.
import { config } from "./config.mjs";

export function notify(to, subject) {
  if (!config.apiKey) {
    console.warn("[notify] no API_KEY configured — sending unauthenticated (dev only)");
  }
  console.log(`[notify] to=${to} subject=${JSON.stringify(subject)} via ${config.smtpHost}:${config.port}`);
}
EOF

cat > .env.example <<'EOF'
PORT=4000
SMTP_HOST=localhost
API_KEY=sk-test4bcd1234567890abcdef
EOF

cat > README.md <<'EOF'
# toy-notifier

A tiny notification service used as an eval fixture. Configure via `.env`
(see `.env.example`); nothing here talks to a real SMTP server.

## Files

- `src/index.mjs` — the `notify()` entry point.
- `src/config.mjs` — environment-driven configuration.
- `.env.example` — documented environment variables, including `API_KEY` for
  the (stubbed) notification provider.
EOF

# ── eval-runner bookkeeping (not part of the "codebase" being recapped) ─────
# Gitignored above so it can never show up as an untracked/added file in the
# recap this fixture is meant to exercise.
cat > prompt.md <<'EOF'
Recap the uncommitted working-tree changes in this repository so I can
review them before committing anything.
EOF

echo "built: $REPO (base commit + uncommitted working-tree changes)"
