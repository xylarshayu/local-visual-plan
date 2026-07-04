# Third-party notices

This repository vendors the following components inside the installable
skills (`skills/present/renderer/vendor/`). Each remains under its own
license; the repository's MIT license (see `LICENSE`) covers everything else.

## marked (`vendor/marked.esm.js`)

Markdown parser, used at render time in Node.
MIT License — Copyright (c) 2018+, MarkedJS contributors;
Copyright (c) 2011-2018, Christopher Jeffrey.
<https://github.com/markedjs/marked>

## Mermaid (`vendor/mermaid.min.js`)

Diagram renderer, inlined into output pages and run client-side.
MIT License — Copyright (c) 2014-present, Knut Sveidqvist and Mermaid
contributors. <https://github.com/mermaid-js/mermaid>

## Virgil font (`vendor/virgil.woff2`)

The Excalidraw hand-drawn font, embedded as a data URI in pages that use
hand-drawn diagrams. SIL Open Font License 1.1 — Copyright (c) 2020,
Excalidraw. <https://github.com/excalidraw/virgil>

## Design lineage (no code vendored)

The planning discipline documented in the skills is adapted from BuilderIO's
MIT-licensed [`BuilderIO/skills`](https://github.com/BuilderIO/skills)
(`visual-plan` / `visual-recap`). The renderer, formats, and everything this
repository emits are an independent implementation; no BuilderIO code is
included. See the "Credits & inspiration" section of the README.
