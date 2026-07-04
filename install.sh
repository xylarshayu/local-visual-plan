#!/bin/sh
# install.sh — install the present / present-plan / present-recap skills into
# your agent skill dirs.
#
# Architecture: ONE engine (skills/present/renderer, which holds render.mjs,
# recap.mjs, annotate.js, check.mjs) owned by the base `present` skill, with
# `present-plan` and `present-recap` as thin workflow adapters on top. Each
# installed skill gets its own self-sufficient copy of the engine + references,
# so no install ever depends on another skill (or this repo's path) being
# present.
#
# Targets: ~/.claude/skills (Claude Code) and ~/.agents/skills (the shared path
# for Codex, Gemini CLI, Cursor, OpenCode, Copilot).
#
# POSIX sh, idempotent: re-run any time to update. No npm install, no network.
# Removes installs under previous generations' names (visual-plan/visual-recap,
# presentation-plan/presentation-recap) so old and new never double-trigger.
# If this file loses its executable bit:  chmod +x install.sh  (or:  sh install.sh)

set -eu

SCRIPT_PATH="$0"
if [ -L "$SCRIPT_PATH" ]; then SCRIPT_PATH=$(readlink "$SCRIPT_PATH"); fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)

BASE="$SCRIPT_DIR/skills/present"

[ -d "$BASE/renderer" ] || { echo "error: engine not found at: $BASE/renderer" >&2; exit 1; }
for s in present present-plan present-recap; do
  [ -f "$SCRIPT_DIR/skills/$s/SKILL.md" ] || { echo "error: missing $SCRIPT_DIR/skills/$s/SKILL.md" >&2; exit 1; }
done

BASES="$HOME/.claude/skills $HOME/.agents/skills"

echo "Installing present + present-plan + present-recap"
echo "  from: $SCRIPT_DIR/skills"
echo

for base in $BASES; do
  mkdir -p "$base"

  # --- retire previous generations' names -------------------------------------
  for old in visual-plan visual-recap presentation-plan presentation-recap; do
    if [ -d "$base/$old" ]; then
      rm -rf "$base/$old"
      echo "  removed old  -> $base/$old"
    fi
  done

  # --- present: the base skill (engine + references live here natively) ------
  dest="$base/present"
  rm -rf "$dest"; mkdir -p "$dest"
  cp -R "$BASE/." "$dest/"
  echo "  installed -> $dest"

  # --- adapters: own SKILL.md + a self-sufficient copy of engine & refs ------
  for s in present-plan present-recap; do
    dest="$base/$s"
    rm -rf "$dest"; mkdir -p "$dest"
    cp "$SCRIPT_DIR/skills/$s/SKILL.md" "$dest/SKILL.md"
    cp -R "$BASE/renderer" "$dest/renderer"
    cp -R "$BASE/references" "$dest/references"
    echo "  installed -> $dest  (shares the present engine)"
  done
  echo
done

echo "Done. All three skills installed to ~/.claude/skills and ~/.agents/skills."
echo "Re-run ./install.sh any time to update."
