# Hand-drawn diagrams + warm restyle — design

**Date:** 2026-06-21
**Status:** implemented

## Problem

The user found Mermaid's default rendering slightly high-cognitive-load and
"clinical," and wondered whether **Excalidraw** would be more expressive. They
wanted the friendly hand-drawn aesthetic of Excalidraw, fully local, with no new
setup — plus a warmer page style they discovered they liked, and reliable
auto-open.

## Decision: hand-drawn **Mermaid**, not Excalidraw

Investigated using Excalidraw (incl. the `excalidraw-diagram-generator` skill at
`The-HIMS/.claude/skills`). Rejected as the diagram engine:

- **Authoring tax.** `.excalidraw` is absolute-coordinate JSON with **no
  auto-layout**: the agent must hand-place every node and wire every arrow
  binding — ~10× the tokens of Mermaid's `A --> B` (dagre lays it out) and far
  more error-prone. The skill itself leans on templates because freehand JSON is
  so painful.
- **Offline cost.** Rendering `.excalidraw` offline needs either a DOM (jsdom) or
  headless Chromium; the only zero-dep path is hand-writing a roughjs serializer
  (reimplementing a slice of Excalidraw). One popular renderer even fetches from
  `esm.sh` at startup — a data-egress dealbreaker.

**Key finding:** what the user reacted to was the *aesthetic*, and our
**already-vendored Mermaid 11.15.0 supports `look: 'handDrawn'` natively** (rough.js
is in the bundle). So we get the Excalidraw feel on the pipeline we already have,
with **zero new dependencies** and **no change to authoring** (agent still writes
trivial Mermaid text). Genuine editable Excalidraw scenes would be the only reason
to take the heavy path — the user did not need editability.

## Design (implemented)

1. **Hand-drawn by default.** `interactivity.js` initializes Mermaid with
   `look: 'handDrawn'` + the vendored **Virgil** font (OFL-1.1, embedded as a
   base64 `data:` URI — offline-safe). The font is awaited (`document.fonts.load`)
   **before** `mermaid.run()`, or node boxes size to fallback metrics and clip.
   `diagram` blocks accept `look=clean` to opt a single diagram back to classic
   shapes; that override is injected as Mermaid frontmatter on the diagram source
   (font left as the global Virgil — overriding it per-diagram caused a
   measure/render mismatch that clipped labels).

2. **Warm restyle.** The renderer's palette moved from cool engineering-gray +
   drafting-blue to **warm cream + oxblood `#9b2d2d`** (light) and a warm
   "aged-paper-at-night" dark theme. Implemented purely by retuning the two
   `:root` token blocks in `styles.css`; every component is token-driven.

3. **On-demand diagram reference.** `references/diagrams.md` — a lean
   selection-matrix + per-type syntax guide built from the bundle-verified
   taxonomy (27 of 28 types supported; only ZenUML absent). Loaded only when an
   agent is choosing a diagram type; **zero always-on cost**. Borrows the
   *structure* of `softaworks/agent-toolkit` (MIT) and `spillwave/design-doc-mermaid`
   but is paraphrased and tailored to our `diagram` block — neither external skill
   was adopted (one carries SaaS/render-to-PNG baggage; both skew toward formal
   architecture docs).

4. **Auto-open.** `open.mjs` tries native openers (`$BROWSER` → `wslview` →
   `explorer.exe` → `xdg-open`) and **always prints a `file://` URL + a Windows
   `\\wsl.localhost\…` UNC path**. Harnesses (Claude Code) auto-open the surfaced
   `file://` link; where they don't, it's one click. Interop is probed by actually
   running a Windows no-op (the binfmt entry can read "enabled" while the bridge is
   dead), and openers use `spawnSync` with a timeout so a hung opener is detected
   rather than reported as a false success.

## Out of scope

Genuine editable `.excalidraw` output (would require build-time jsdom +
mermaid-to-excalidraw and/or a custom roughjs serializer). Revisit only if
drag-to-edit diagrams become a hard requirement.
