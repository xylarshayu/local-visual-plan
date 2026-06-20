#!/usr/bin/env node
// Zero-dependency test runner for the visual-plan renderer.
// Uses only node:assert / node:fs / node:path / node:url — no npm install.
// Imports { renderPlan } from ../render.mjs and checks each fixture against the
// data-block / offline contract in references/format.md.
//
// renderPlan(markdownSource, { lean = false } = {})
//   => { html, title, slug, warnings }   // html is the FULL self-contained document
//
// Run:  node skills/visual-plan/renderer/test/run.mjs

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { renderPlan } from '../render.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')

// ---------------------------------------------------------------------------
// Tiny harness: collect (name -> fn) checks per fixture, print PASS/FAIL,
// exit 1 on any failure. No external test framework.
// ---------------------------------------------------------------------------

let totalFail = 0
let totalPass = 0

function read(name) {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/**
 * Run a group of assertions for one fixture. `body` receives a `check(label, fn)`
 * helper; each check is reported independently so one fixture can show several
 * green lines and pinpoint exactly which contract clause regressed.
 */
function fixture(name, body) {
  console.log(`\n# ${name}`)
  const check = (label, fn) => {
    try {
      fn()
      totalPass++
      console.log(`  PASS  ${label}`)
    } catch (err) {
      totalFail++
      console.log(`  FAIL  ${label}`)
      const msg = (err && err.message ? err.message : String(err))
        .split('\n')
        .map((l) => '          ' + l)
        .join('\n')
      console.log(msg)
    }
  }
  try {
    body(check)
  } catch (err) {
    // A throw outside an individual check (e.g. renderPlan itself blew up) fails
    // the whole fixture rather than silently passing.
    totalFail++
    console.log(`  FAIL  <fixture threw before/around checks>`)
    console.log('          ' + (err && err.stack ? err.stack : String(err)))
  }
}

// ---------------------------------------------------------------------------
// Shared offline-purity helpers.
//
// The contract: the output must be a single self-contained file that renders
// fully offline from file:// — no external URL, no CDN, no web-font fetch.
//
// Subtlety: the vendored mermaid bundle (inlined ONLY in the default/non-lean
// build) legitimately contains W3C XML *namespace* URIs (e.g.
// http://www.w3.org/2000/svg) and MIT-license URLs inside comments. Those are
// not network fetches. So we split the offline guarantee into two checks:
//
//   1. assertNoExternalUrl(html)      — STRICT: no http(s):// or protocol-
//      relative //host anywhere. Only valid where mermaid is NOT inlined
//      (i.e. the lean build, and the non-mermaid prose/blocks of any build).
//
//   2. assertNoNetworkFetch(html)     — the real "nothing loads from the
//      network at view time" guarantee: no remote src=/href=, no CDN, no
//      web-font @font-face/@import/url() to a remote, no fetch()/XMLHttpRequest
//      to a URL. Holds even when mermaid is inlined.
// ---------------------------------------------------------------------------

/** Strict: literally no external URL token anywhere in the supplied string. */
function assertNoExternalUrl(html, where) {
  const offenders = []
  // http:// or https:// anywhere.
  for (const m of html.matchAll(/https?:\/\/[^\s"'`)<>]+/gi)) {
    offenders.push(m[0])
  }
  // Protocol-relative //host (e.g. //cdn.jsdelivr.net/...). Exclude bare "//"
  // used as a JS/CSS comment or path by requiring a domain-ish host after it.
  for (const m of html.matchAll(/(^|[\s"'`(=])\/\/[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    offenders.push(m[0].trim())
  }
  assert.equal(
    offenders.length,
    0,
    `expected no external URL in ${where}, found: ${[...new Set(offenders)].slice(0, 8).join(', ')}`,
  )
}

/**
 * The view-time network guarantee. Must hold for BOTH lean and default builds,
 * even though the default build inlines mermaid (which carries namespace URIs).
 * We look specifically for things a browser would actually FETCH.
 */
function assertNoNetworkFetch(html, where) {
  const offenders = []

  // <script src="http..."> or <link href="http..."> / <link href="//..."> etc.
  const remoteAttr = /\b(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']+["']/gi
  for (const m of html.matchAll(remoteAttr)) offenders.push('remote attr: ' + m[0])

  // <img src="http...">, <iframe src="http...">, <source src="http..."> covered
  // by remoteAttr above. Also catch url(...) pointing at a remote in inline CSS.
  const remoteCssUrl = /url\(\s*["']?(?:https?:)?\/\/[^)\s"']+/gi
  for (const m of html.matchAll(remoteCssUrl)) offenders.push('css url(): ' + m[0])

  // @import of a remote stylesheet / web font.
  const remoteImport = /@import\s+(?:url\()?\s*["'](?:https?:)?\/\/[^"']+/gi
  for (const m of html.matchAll(remoteImport)) offenders.push('@import: ' + m[0])

  // Common CDN / web-font hosts, wherever they appear (catches anything the
  // patterns above missed, e.g. a string passed to fetch()).
  const cdnHosts =
    /\b(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|esm\.sh|skypack\.dev|googleapis\.com)\b/gi
  for (const m of html.matchAll(cdnHosts)) offenders.push('cdn host: ' + m[0])

  // A literal fetch("http...") / fetch('//...') at view time.
  const remoteFetch = /\bfetch\s*\(\s*["'`](?:https?:)?\/\/[^"'`]+/gi
  for (const m of html.matchAll(remoteFetch)) offenders.push('fetch(): ' + m[0])

  assert.equal(
    offenders.length,
    0,
    `expected no view-time network fetch in ${where}, found:\n  ${[...new Set(offenders)].slice(0, 8).join('\n  ')}`,
  )
}

/** Assert a stable data-block marker appears at least `min` times. */
function hasBlock(html, type, min = 1) {
  const re = new RegExp(`data-block=["']${type}["']`, 'g')
  const n = (html.match(re) || []).length
  assert.ok(
    n >= min,
    `expected at least ${min} data-block="${type}", found ${n}`,
  )
  return n
}

/** Count occurrences of a literal substring. */
function count(html, needle) {
  let n = 0
  let i = 0
  for (;;) {
    i = html.indexOf(needle, i)
    if (i === -1) break
    n++
    i += needle.length
  }
  return n
}

// ---------------------------------------------------------------------------
// Fixture: all-blocks.md — every block type + both diff modes.
// ---------------------------------------------------------------------------
fixture('all-blocks.md', (check) => {
  const src = read('all-blocks.md')
  const { html, title, slug, warnings } = renderPlan(src)

  check('renderPlan returns the documented shape', () => {
    assert.equal(typeof html, 'string')
    assert.ok(html.length > 0, 'html is non-empty')
    assert.equal(typeof title, 'string')
    assert.equal(typeof slug, 'string')
    assert.ok(Array.isArray(warnings), 'warnings is an array')
  })

  check('title comes from frontmatter', () => {
    assert.equal(title, 'All Blocks & Both Diff Modes')
  })

  check('slug is kebab-case of the title', () => {
    assert.equal(slug, 'all-blocks-both-diff-modes')
  })

  check('output is a full self-contained HTML document', () => {
    assert.match(html, /<!doctype html>/i)
    assert.match(html, /<html[\s>]/i)
    assert.match(html, /<\/html>\s*$/i)
    // Inlined assets, not external references.
    assert.match(html, /<style[\s>]/i, 'inline <style> present')
    assert.match(html, /<script[\s>]/i, 'inline <script> present')
  })

  // --- steps ---
  check('steps -> <ol data-block="steps"> with .step / .step-title', () => {
    hasBlock(html, 'steps')
    assert.match(html, /<ol[^>]*data-block=["']steps["']/i)
    assert.ok(count(html, 'class="step"') >= 2 || /class="[^"]*\bstep\b[^"]*"/.test(html),
      'at least two .step items (two steps authored)')
    assert.match(html, /step-title/, '.step-title present')
    assert.match(html, /step-why/, '.step-why present (rationale)')
    assert.match(html, /step-files/, '.step-files present')
  })

  check('steps file verbs carry data-change=reuse|edit|new|delete', () => {
    for (const verb of ['reuse', 'edit', 'new', 'delete']) {
      assert.match(
        html,
        new RegExp(`data-change=["']${verb}["']`),
        `data-change="${verb}" present`,
      )
    }
  })

  // --- filetree ---
  check('filetree -> data-block="filetree" with tree-row change/depth', () => {
    hasBlock(html, 'filetree')
    assert.match(html, /tree-row/, '.tree-row present')
    assert.match(html, /tree-path/, '.tree-path present')
    assert.match(html, /tree-note/, '.tree-note present')
    assert.match(html, /data-depth=/, 'data-depth present')
    for (const change of ['added', 'modified', 'deleted', 'unchanged']) {
      assert.match(
        html,
        new RegExp(`data-change=["']${change}["']`),
        `tree data-change="${change}" present`,
      )
    }
  })

  // --- diff (both modes) ---
  check('diff -> two <figure data-block="diff"> (unified + split)', () => {
    hasBlock(html, 'diff', 2)
    assert.match(html, /data-mode=["']unified["']/, 'unified mode present')
    assert.match(html, /data-mode=["']split["']/, 'split mode present')
  })

  check('diff lines carry data-line=add|del|ctx|hunk and notes render', () => {
    for (const kind of ['add', 'del', 'ctx', 'hunk']) {
      assert.match(
        html,
        new RegExp(`data-line=["']${kind}["']`),
        `diff data-line="${kind}" present`,
      )
    }
    assert.match(html, /diff-note/, '.diff-note callout present')
  })

  check('diff file label renders in a <figcaption>', () => {
    assert.match(html, /<figcaption[^>]*>[^<]*upload\.ts/i)
  })

  // --- code ---
  check('code -> <figure data-block="code" data-lang="ts"> numbered lines', () => {
    hasBlock(html, 'code')
    assert.match(html, /data-lang=["']ts["']/, 'data-lang="ts" present')
    assert.match(html, /code-lines/, '.code-lines present')
    assert.match(html, /data-hl=["']1["']/, 'highlighted line carries data-hl="1"')
    assert.match(html, /code-note/, '.code-note callout present')
  })

  // --- diagram (default build: mermaid present client-side) ---
  check('diagram -> <figure data-block="diagram"> with <pre class="mermaid">', () => {
    hasBlock(html, 'diagram')
    assert.match(html, /class=["'][^"']*\bmermaid\b[^"']*["']/, '.mermaid container present')
    assert.match(html, /flowchart LR/, 'raw mermaid source preserved')
  })

  // --- wireframe ---
  check('wireframe -> <figure data-block="wireframe" data-surface="page">', () => {
    hasBlock(html, 'wireframe')
    assert.match(html, /data-surface=["']page["']/, 'data-surface="page" present')
    assert.match(html, /wf-screen/, '.wf-screen surface frame present')
    // wireframe bodies pass through as HTML by design.
    assert.match(html, /wf-toolbar/, "author's wireframe body preserved")
    assert.match(html, /wf-btn/, '.wf-btn from body preserved')
  })

  // --- questions ---
  check('questions -> data-block="questions" with .question/.q-text/.q-default', () => {
    hasBlock(html, 'questions')
    assert.match(html, /class=["'][^"']*\bquestion\b[^"']*["']/, '.question present')
    assert.match(html, /q-text/, '.q-text present')
    assert.match(html, /q-default/, '.q-default present')
  })

  // --- escaping: a <script> in text content must not be live ---
  check('prose-extracted text is HTML-escaped (no injected live tags)', () => {
    // The fixture text never includes a raw <script>; sanity that no
    // unexpected executable tag leaked from block text content. We assert the
    // documented escaping by checking the diff/code bodies did not introduce a
    // stray closing </figure> mid-body that would break the structure.
    assert.match(html, /&lt;|&gt;|&amp;/, 'HTML entities present from escaping')
  })

  // --- offline purity ---
  check('default build performs no view-time network fetch', () => {
    assertNoNetworkFetch(html, 'all-blocks default build')
  })
})

// ---------------------------------------------------------------------------
// Fixture: grouping.md — tabs + collapsible.
// ---------------------------------------------------------------------------
fixture('grouping.md', (check) => {
  const src = read('grouping.md')
  const { html } = renderPlan(src)

  check('tabs -> <div data-block="tabs"> with .tab-bar + .tab-panel', () => {
    hasBlock(html, 'tabs')
    assert.match(html, /tab-bar/, '.tab-bar present')
    assert.match(html, /tab-panel/, '.tab-panel present')
    // Two tabs authored (Before / After) -> at least two panels.
    assert.ok(count(html, 'tab-panel') >= 2, 'at least two .tab-panel')
  })

  check('collapsible -> <details data-block="collapsible"> with <summary>', () => {
    hasBlock(html, 'collapsible')
    assert.match(html, /<details[^>]*data-block=["']collapsible["']/i)
    assert.match(html, /<summary[\s>]/i, '<summary> present')
    assert.match(html, /Verification details/, 'collapsible label in summary')
  })

  check('blocks nested inside groups still render', () => {
    // code block inside the "Before" tab; diff inside "After"; filetree inside
    // the collapsible — all must survive grouping.
    hasBlock(html, 'code')
    hasBlock(html, 'diff')
    hasBlock(html, 'filetree')
  })

  check('grouping build performs no view-time network fetch', () => {
    assertNoNetworkFetch(html, 'grouping build')
  })
})

// ---------------------------------------------------------------------------
// Fixture: unknown-block.md — unrecognized type must become data-block="unknown".
// ---------------------------------------------------------------------------
fixture('unknown-block.md', (check) => {
  const src = read('unknown-block.md')
  const { html } = renderPlan(src)

  check('unknown block -> <pre data-block="unknown" data-type="...">', () => {
    hasBlock(html, 'unknown')
    assert.match(html, /<pre[^>]*data-block=["']unknown["']/i, 'rendered as <pre>')
    assert.match(
      html,
      /data-type=["']sequencediagram["']/,
      'data-type carries the original info-string type',
    )
  })

  check('unknown block is NOT dropped — raw body is preserved (escaped)', () => {
    assert.match(html, /Alice/, 'body text preserved')
    assert.match(html, /Bob/, 'body text preserved')
  })

  check('unknown block body is escaped, never executed', () => {
    // The fixture body contains a literal <script>; it must appear escaped and
    // must NOT appear as a live, executable <script> tag inside the unknown pre.
    assert.match(
      html,
      /&lt;script&gt;alert\(/,
      'embedded <script> is HTML-escaped',
    )
    assert.ok(
      !/<script>alert\('this raw body must be escaped, not executed'\)<\/script>/.test(html),
      'embedded script tag from the body is not emitted live',
    )
  })

  check('ordinary ```js fence does NOT become data-block="unknown"', () => {
    // A standard language fence is plain Markdown, not a custom block. It must
    // render via marked and must not be misclassified as an unknown custom block.
    assert.match(html, /console\.log/, 'ordinary code fence content present')
    assert.ok(
      !/data-block=["']unknown["'][^>]*data-type=["']js["']/.test(html),
      'plain js fence is not marked as an unknown custom block',
    )
    // Exactly one unknown block (the sequencediagram), not two.
    assert.equal(hasBlock(html, 'unknown'), 1, 'exactly one unknown block')
  })

  check('unknown-block build performs no view-time network fetch', () => {
    assertNoNetworkFetch(html, 'unknown-block build')
  })
})

// ---------------------------------------------------------------------------
// Fixture: full-plan.md — realistic end-to-end plan + the lean/default mermaid
// inlining contract + strict offline purity on the lean build.
// ---------------------------------------------------------------------------
fixture('full-plan.md', (check) => {
  const src = read('full-plan.md')
  const def = renderPlan(src) // default: mermaid inlined
  const lean = renderPlan(src, { lean: true }) // lean: mermaid NOT inlined

  check('frontmatter title/objective/status surface in the document', () => {
    assert.equal(def.title, 'Add a 5MB Upload Size Guard')
    assert.match(def.html, /Add a 5MB Upload Size Guard/)
    assert.match(def.html, /Reject oversized uploads/, 'objective rendered')
    // status pill — the value should appear somewhere (header pill).
    assert.match(def.html, /approved/i, 'status value rendered')
  })

  check('realistic plan renders all of its block types', () => {
    for (const t of ['steps', 'filetree', 'diff', 'code', 'diagram', 'tabs', 'collapsible', 'questions']) {
      hasBlock(def.html, t)
    }
  })

  check('a single questions block lives at the bottom', () => {
    assert.equal(hasBlock(def.html, 'questions'), 1, 'exactly one questions block')
    const qIdx = def.html.indexOf('data-block="questions"')
    const stepsIdx = def.html.indexOf('data-block="steps"')
    assert.ok(qIdx > stepsIdx, 'questions block appears after the steps block')
  })

  // --- the core lean vs default contract ---
  check('DEFAULT build INLINES the mermaid bundle', () => {
    // The inlined bundle is large; assert a real signature of mermaid source,
    // and that the default html is substantially larger than the lean html.
    assert.ok(
      /mermaid/i.test(def.html),
      'mermaid referenced in default build',
    )
    assert.ok(
      def.html.length > lean.html.length,
      `default html (${def.html.length}) should be larger than lean (${lean.html.length}) because mermaid is inlined`,
    )
    // A fingerprint that only the actual mermaid library bundle contains, not
    // merely the <pre class="mermaid"> tag (which exists in both builds).
    const mermaidSrc = readFileSync(
      join(__dirname, '..', 'vendor', 'mermaid.min.js'),
      'utf8',
    )
    const fingerprint = mermaidSrc.slice(0, 200).replace(/\s+/g, ' ').trim().slice(0, 40)
    if (fingerprint.length >= 12) {
      const flat = def.html.replace(/\s+/g, ' ')
      assert.ok(
        flat.includes(fingerprint.slice(0, 12)) || /mermaid@|mermaidAPI|class MermaidConfig|function mermaid/i.test(def.html),
        'default build contains the actual inlined mermaid bundle source',
      )
    }
  })

  check('LEAN build does NOT inline the mermaid bundle', () => {
    // The bundle's namespace URIs / license URLs are a reliable tell that the
    // full library is present. In lean mode they must be absent.
    assert.ok(
      !def_or_lean_has_bundle(lean.html),
      'lean build must not contain the mermaid library bundle',
    )
    // The diagram itself is still represented (as a labeled code block per
    // format.md), so its source is not lost.
    assert.match(lean.html, /flowchart LR/, 'diagram source still present in lean build')
  })

  // --- offline purity ---
  check('LEAN build is strictly free of any external URL', () => {
    // With mermaid NOT inlined, the lean output should contain zero http(s)://
    // and zero protocol-relative //host — the strongest offline guarantee.
    assertNoExternalUrl(lean.html, 'full-plan lean build')
  })

  check('LEAN build performs no view-time network fetch', () => {
    assertNoNetworkFetch(lean.html, 'full-plan lean build')
  })

  check('DEFAULT build performs no view-time network fetch', () => {
    // Even with mermaid inlined (which carries W3C namespace URIs and license
    // URLs that are NOT fetches), nothing is loaded from the network.
    assertNoNetworkFetch(def.html, 'full-plan default build')
  })
})

/**
 * Heuristic: does this html contain the actual mermaid *library* bundle (as
 * opposed to just a <pre class="mermaid"> diagram container)? The library bundle
 * is large and carries W3C SVG/MathML namespace URIs that the diagram container
 * alone never includes.
 */
function def_or_lean_has_bundle(html) {
  // The standalone diagram container is tiny; the library is tens/hundreds of KB.
  const hasNamespaceUri = /http:\/\/www\.w3\.org\/2000\/svg/.test(html)
  const isLarge = html.length > 200000
  const hasLibFingerprint = /mermaidAPI|class MermaidConfig|registerDiagram|getDiagramFromText|function mermaid\b/.test(html)
  return hasNamespaceUri || isLarge || hasLibFingerprint
}

// ---------------------------------------------------------------------------
// Fixture: empty.md — title-only near-empty plan must still produce a valid doc.
// ---------------------------------------------------------------------------
fixture('empty.md', (check) => {
  const src = read('empty.md')
  const { html, title, slug } = renderPlan(src)

  check('title-only plan still renders a full, valid HTML document', () => {
    assert.equal(title, 'Title Only Edge Plan')
    assert.equal(slug, 'title-only-edge-plan')
    assert.match(html, /<!doctype html>/i)
    assert.match(html, /<\/html>\s*$/i)
    assert.match(html, /Title Only Edge Plan/, 'title rendered in the page')
  })

  check('no custom blocks present (none authored)', () => {
    for (const t of ['steps', 'filetree', 'diff', 'code', 'diagram', 'wireframe', 'questions', 'tabs', 'collapsible', 'unknown']) {
      assert.ok(
        !new RegExp(`data-block=["']${t}["']`).test(html),
        `no data-block="${t}" for a title-only plan`,
      )
    }
  })

  check('empty plan default build performs no view-time network fetch', () => {
    assertNoNetworkFetch(html, 'empty default build')
  })

  check('empty plan lean build is strictly free of external URLs', () => {
    const { html: leanHtml } = renderPlan(src, { lean: true })
    assertNoExternalUrl(leanHtml, 'empty lean build')
  })
})

// ---------------------------------------------------------------------------
// Sanity: every .md fixture present in fixtures/ was actually exercised above.
// Guards against adding a fixture file but forgetting to assert on it.
// ---------------------------------------------------------------------------
fixture('<coverage>', (check) => {
  const onDisk = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.md'))
    .sort()
  const exercised = ['all-blocks.md', 'empty.md', 'full-plan.md', 'grouping.md', 'unknown-block.md'].sort()
  check('every fixture file on disk is covered by a test block', () => {
    assert.deepEqual(
      onDisk,
      exercised,
      `fixtures on disk vs. exercised differ — update run.mjs`,
    )
  })
})

// ---------------------------------------------------------------------------
// Regression: placeholder/attribute hardening. These exercise renderPlan on
// inline source (no fixture file) so they don't need a fixtures/ entry.
// ---------------------------------------------------------------------------
fixture('<regression: placeholder & attrs>', (check) => {
  // Finding 1a: a literal VPBLOCK_<n> in prose, with NO real custom blocks,
  // must survive verbatim (previously silently deleted).
  check('literal VPBLOCK_<n> in prose survives when no blocks exist', () => {
    const { html } = renderPlan(
      '---\ntitle: T\n---\n\nHere is literal text: VPBLOCK_0 end. Also VPBLOCK_5 here.\n',
    )
    assert.match(html, /VPBLOCK_0/, 'VPBLOCK_0 preserved in prose')
    assert.match(html, /VPBLOCK_5/, 'VPBLOCK_5 preserved in prose')
    assert.match(html, /Here is literal text: VPBLOCK_0 end\./, 'prose intact, not deleted')
  })

  // Finding 1b: a literal VPBLOCK_<n> in prose must NOT inject an unrelated
  // real block's HTML mid-paragraph.
  check('literal VPBLOCK_<n> does not steal a real block when one exists', () => {
    const src =
      '---\ntitle: T\n---\n\n' +
      'Mentioning the placeholder VPBLOCK_0 in prose.\n\n' +
      '```steps\n# Do a thing\nedit src/x.ts — change it\n```\n'
    const { html } = renderPlan(src)
    assert.match(html, /VPBLOCK_0/, 'literal token preserved in prose')
    // The steps block still renders exactly once, in its own place — not nested
    // inside the prose paragraph.
    assert.equal(hasBlock(html, 'steps'), 1, 'steps block rendered exactly once')
    assert.ok(
      !/<p>[^<]*VPBLOCK_0[^<]*<ol[^>]*data-block=["']steps["']/.test(html),
      'steps <ol> is not injected into the prose paragraph at the literal token',
    )
  })

  // Finding 2: unquoted attribute value with a space is truncated; the contract
  // now requires quoting. A QUOTED multi-word title must render in full.
  check('quoted diagram title with spaces renders in full', () => {
    const { html } = renderPlan(
      '---\ntitle: T\n---\n\n```diagram title="Upload flow"\nflowchart LR\n  A-->B\n```\n',
    )
    assert.match(html, /<figcaption[^>]*>Upload flow<\/figcaption>/, 'full title "Upload flow"')
  })

  // Finding 3: the toolbar surface frame must be ONLY .wf-toolbar-surface, never
  // the bare body-element .wf-toolbar class.
  check('toolbar surface frame does not get the bare wf-toolbar class', () => {
    const { html } = renderPlan(
      '---\ntitle: T\n---\n\n```wireframe surface=toolbar\n<span class="wf-title">Tools</span>\n```\n',
    )
    assert.match(html, /class="wf-screen wf-toolbar-surface[^"]*"/, 'frame is wf-screen wf-toolbar-surface')
    assert.ok(
      !/class="wf-screen[^"]*\bwf-toolbar\b(?!-surface)[^"]*"/.test(html),
      'frame class must not include the bare wf-toolbar body-element class',
    )
  })

  // Finding 4: an empty attribute value must not steal the following key=value.
  check('empty-valued attribute does not steal the next attribute', () => {
    const { html } = renderPlan(
      '---\ntitle: T\n---\n\n```code lang= file=src/x.ts\nconst a = 1\n```\n',
    )
    // lang is empty (not "file="); file is parsed independently and labels the figure.
    assert.ok(
      !/data-lang=["'][^"']*file["']/.test(html),
      'lang must not capture the following file= token',
    )
    assert.match(html, /data-lang=["']["']/, 'empty lang= yields an empty data-lang')
    assert.match(html, /class="code-file">src\/x\.ts</, 'file attr still labels the figure')
  })
})

// ---------------------------------------------------------------------------
// Summary + exit code.
// ---------------------------------------------------------------------------
console.log('\n' + '─'.repeat(60))
console.log(`Total: ${totalPass} passed, ${totalFail} failed`)
if (totalFail > 0) {
  console.log('RESULT: FAIL')
  process.exit(1)
} else {
  console.log('RESULT: PASS')
}

// Keep pathToFileURL imported-and-used note: available for future fixture
// loaders that need file:// URLs; referenced here to avoid an unused import in
// strict linters without changing behavior.
void pathToFileURL
