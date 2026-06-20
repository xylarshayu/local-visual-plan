#!/bin/sh
# install.sh — install the local visual-plan skill into your agent skill dirs.
#
# Recursively copies skills/visual-plan/ (renderer + references + SKILL.md, all
# of it) into BOTH ~/.claude/skills/visual-plan/ and ~/.agents/skills/visual-plan/
# so the installed skill is fully self-sufficient — it carries its own vendored
# renderer and never depends on this repo's location.
#
# POSIX sh, idempotent: re-run any time to update; it overwrites the installed
# copies from this repo. No npm install, no network.
#
# If this file ever loses its executable bit, run:  chmod +x install.sh
# (or invoke it as:  sh install.sh)

set -eu

# --- Resolve this script's own directory so it runs from anywhere ----------
# Follow a single symlink level if needed, then cd to the containing dir.
SCRIPT_PATH="$0"
if [ -L "$SCRIPT_PATH" ]; then
	SCRIPT_PATH=$(readlink "$SCRIPT_PATH")
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$SCRIPT_PATH")" && pwd -P)

SRC="$SCRIPT_DIR/skills/visual-plan"

if [ ! -d "$SRC" ]; then
	echo "error: source skill not found at: $SRC" >&2
	echo "       run install.sh from inside the local-visual-plan repo." >&2
	exit 1
fi

# --- Targets ----------------------------------------------------------------
# ~/.claude  -> Claude Code
# ~/.agents  -> shared path used by Codex, Gemini CLI, Cursor, OpenCode, Copilot
TARGETS="$HOME/.claude/skills/visual-plan $HOME/.agents/skills/visual-plan"

# --- Recursive copy helper (no external deps beyond cp/mkdir/rm) ------------
# Overwrites any prior copy: remove the destination skill dir first so stale
# files (e.g. a renamed reference) don't linger, then copy the whole tree.
install_to() {
	dest="$1"
	parent=$(dirname -- "$dest")
	mkdir -p "$parent"
	rm -rf "$dest"
	mkdir -p "$dest"
	# Copy contents of $SRC into $dest (the trailing /. copies the directory's
	# contents, including dotfiles, preserving the renderer/ subtree).
	cp -R "$SRC/." "$dest/"
}

echo "Installing visual-plan skill"
echo "  from: $SRC"
echo

for dest in $TARGETS; do
	install_to "$dest"
	echo "  installed -> $dest"
	# Show what landed: list the top-level entries and confirm the bundled
	# renderer survived the copy so the installed skill is self-sufficient.
	for entry in SKILL.md references renderer renderer/render.mjs renderer/vendor; do
		if [ -e "$dest/$entry" ]; then
			echo "      + $entry"
		fi
	done
	echo
done

echo "Done. Re-run ./install.sh any time to update both copies."
