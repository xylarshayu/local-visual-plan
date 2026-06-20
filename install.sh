#!/bin/sh
# install.sh — install the local visual-plan + visual-recap skills into your
# agent skill dirs.
#
# Both skills share ONE renderer (skills/visual-plan/renderer, which holds
# render.mjs AND recap.mjs). Each installed skill gets its own self-sufficient
# copy of that renderer + references, so it never depends on this repo's path.
#
# Targets: ~/.claude/skills (Claude Code) and ~/.agents/skills (the shared path
# for Codex, Gemini CLI, Cursor, OpenCode, Copilot).
#
# POSIX sh, idempotent: re-run any time to update. No npm install, no network.
# If this file loses its executable bit:  chmod +x install.sh  (or:  sh install.sh)

set -eu

SCRIPT_PATH="$0"
if [ -L "$SCRIPT_PATH" ]; then SCRIPT_PATH=$(readlink "$SCRIPT_PATH"); fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)

PLAN="$SCRIPT_DIR/skills/visual-plan"
RECAP="$SCRIPT_DIR/skills/visual-recap"

[ -d "$PLAN" ] || { echo "error: source skill not found at: $PLAN" >&2; exit 1; }
[ -f "$RECAP/SKILL.md" ] || { echo "error: recap skill not found at: $RECAP/SKILL.md" >&2; exit 1; }

BASES="$HOME/.claude/skills $HOME/.agents/skills"

echo "Installing visual-plan + visual-recap"
echo "  from: $SCRIPT_DIR/skills"
echo

for base in $BASES; do
  # --- visual-plan: the whole skill (its renderer travels inside it) ---------
  dest="$base/visual-plan"
  mkdir -p "$base"
  rm -rf "$dest"; mkdir -p "$dest"
  cp -R "$PLAN/." "$dest/"
  echo "  installed -> $dest"

  # --- visual-recap: its SKILL.md + a copy of the shared renderer & refs ------
  dest="$base/visual-recap"
  rm -rf "$dest"; mkdir -p "$dest"
  cp "$RECAP/SKILL.md" "$dest/SKILL.md"
  cp -R "$PLAN/renderer" "$dest/renderer"
  cp -R "$PLAN/references" "$dest/references"
  echo "  installed -> $dest  (shares the visual-plan renderer)"
  echo
done

echo "Done. Both skills installed to ~/.claude/skills and ~/.agents/skills."
echo "Re-run ./install.sh any time to update."
