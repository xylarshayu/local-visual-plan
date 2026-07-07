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

/** Extract the raw JSON text of the baked-in anchor map (unparsed). */
function anchorMapRaw(html) {
  const m = html.match(/id="pf-anchor-map">([\s\S]*?)<\/script>/)
  assert.ok(m, 'pf-anchor-map script present')
  return m[1]
}

/** Extract + JSON.parse the baked-in anchor map. */
function anchorMap(html) {
  return JSON.parse(anchorMapRaw(html))
}

/** Decode the base64 embedded plan source. */
function embeddedSource(html) {
  const m = html.match(/id="pf-source" data-encoding="base64">([\s\S]*?)<\/script>/)
  assert.ok(m, 'pf-source script present')
  return Buffer.from(m[1], 'base64').toString('utf8')
}

/** All `id="..."` attribute values in document order. */
function allIds(html) {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1])
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

  check('questions render the interactive answer form (contract markup)', () => {
    assert.match(html, /class="q-form"/, '.q-form present')
    assert.match(html, /<textarea class="q-custom"/, '.q-custom textarea present')
    // Two authored questions -> two radio groups, each with default (checked) + custom.
    assert.match(html, /<input type="radio" name="q:[^"]+" value="default" checked>/, 'default radio checked')
    assert.match(html, /<input type="radio" name="q:[^"]+" value="custom">/, 'custom radio present')
    // The radio group name matches the question's own anchor.
    const qAnchor = (html.match(/class="question" data-pf-anchor="(q:[^"]+)"/) || [])[1]
    assert.ok(qAnchor, 'question carries a q: anchor')
    assert.ok(count(html, `name="${qAnchor}"`) >= 2, 'both radios share the question anchor as name')
  })

  // --- escaping: a <script> in text content must not be live ---
  check('prose-extracted text is HTML-escaped (no injected live tags)', () => {
    // The fixture text never includes a raw <script>; sanity that no
    // unexpected executable tag leaked from block text content. We assert the
    // documented escaping by checking the diff/code bodies did not introduce a
    // stray closing </figure> mid-body that would break the structure.
    assert.match(html, /&lt;|&gt;|&amp;/, 'HTML entities present from escaping')
  })

  // --- anchors: every addressable element carries data-pf-anchor AND id ---
  check('every data-pf-anchor has a matching id="<anchor>"', () => {
    const anchors = [...html.matchAll(/data-pf-anchor="([^"]+)"/g)].map((m) => m[1])
    assert.ok(anchors.length >= 10, `expected many anchors, found ${anchors.length}`)
    for (const a of anchors) {
      assert.ok(
        html.includes(`data-pf-anchor="${a}" id="${a}"`),
        `anchor ${a} must be accompanied by id="${a}"`,
      )
    }
  })

  check('anchor ids are unique (no duplicate id in the document)', () => {
    const ids = allIds(html)
    const dupes = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))]
    assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`)
  })

  check('kind-prefixed anchors exist for step/file/diff/code/diagram/wireframe/q', () => {
    for (const kind of ['step', 'file', 'diff', 'code', 'diagram', 'wireframe', 'q']) {
      assert.match(html, new RegExp(`data-pf-anchor="${kind}:`), `${kind}: anchor present`)
    }
    // diff hunk anchor: <parent>:h<i> on the hunk header row.
    assert.match(html, /data-pf-anchor="diff:[^"]+:h1"/, 'diff hunk h1 anchor present')
  })

  // --- anchor map + embedded source + docId plumbing ---
  check('anchor map is valid JSON with the documented shape', () => {
    const map = anchorMap(html)
    assert.equal(map.version, 1)
    assert.match(map.docId, /^pf-[0-9a-f]{12}$/, 'docId is pf- + 12 hex')
    assert.equal(map.source, null, 'source is null when no sourcePath passed')
    assert.equal(map.title, 'All Blocks & Both Diff Modes')
    assert.equal(typeof map.anchors, 'object')
    // Every anchor entry has kind + label + lines (array|null).
    for (const [a, v] of Object.entries(map.anchors)) {
      assert.equal(typeof v.kind, 'string', `${a}.kind`)
      assert.equal(typeof v.label, 'string', `${a}.label`)
      assert.ok(v.lines === null || (Array.isArray(v.lines) && v.lines.length === 2), `${a}.lines`)
    }
  })

  check('anchor map "source" carries the absolute path when provided', () => {
    const { html: h2 } = renderPlan(src, { sourcePath: '/abs/path/plan.md' })
    assert.equal(anchorMap(h2).source, '/abs/path/plan.md')
  })

  check('a top-level block\'s line range is exact (steps block, counted by hand)', () => {
    const map = anchorMap(html)
    // In all-blocks.md the first steps block is:
    //   line 15 ```steps
    //   line 16 # Add a size guard to the upload action      <- step 1 title
    //   ... through line 22 (last `>` rationale)
    //   line 23 # Wire the validator into the action         <- step 2 title
    //   lines 24-25 body ; line 26 ```
    assert.deepEqual(map.anchors['step:add-a-size-guard-to-the-upload-action'].lines, [16, 22])
    assert.deepEqual(map.anchors['step:wire-the-validator-into-the-action'].lines, [23, 25])
    // A filetree row is a single source line.
    assert.deepEqual(map.anchors['file:src-actions-upload-ts'].lines, [32, 32])
  })

  check('embedded plan source round-trips exactly (base64 decodes to input)', () => {
    assert.equal(embeddedSource(html), src)
  })

  check('"</" never appears unescaped inside the anchor-map JSON', () => {
    const raw = anchorMapRaw(html)
    assert.ok(!raw.includes('</'), 'no raw "</" inside the JSON island')
    // ...and it is still valid JSON after the <\/ escaping.
    JSON.parse(raw)
  })

  check('renderPlan returns a deterministic docId (same input -> same id)', () => {
    const a = renderPlan(src).docId
    const b = renderPlan(src).docId
    assert.equal(a, b)
    assert.match(a, /^pf-[0-9a-f]{12}$/)
    // A one-character change flips it.
    const c = renderPlan(src + '\n<!-- x -->').docId
    assert.notEqual(a, c)
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
// Fixture: chapters.md — chapter directive, side nav, Overview intro, nesting.
// ---------------------------------------------------------------------------
fixture('chapters.md', (check) => {
  const src = read('chapters.md')
  const { html } = renderPlan(src, { sourcePath: '/x/chapters.md' })

  check('body switches to the two-column layout via data-has-chapters', () => {
    assert.match(html, /<body[^>]*\bdata-has-chapters="true"/, 'data-has-chapters on <body>')
  })

  check('content before the first marker becomes an "Overview" chapter', () => {
    assert.match(html, /<section class="pf-chapter"[^>]*id="chapter:overview"/, 'Overview section present')
    assert.match(html, /pf-chapter-heading">Overview</, 'Overview heading rendered')
    // The intro prose lives inside it.
    assert.match(html, /This intro sits before any chapter marker/)
  })

  check('each chapter renders a <section class="pf-chapter"> with anchor + id', () => {
    for (const slug of ['chapter:overview', 'chapter:the-problem', 'chapter:the-solution']) {
      assert.ok(
        html.includes(`<section class="pf-chapter" data-pf-anchor="${slug}" id="${slug}">`),
        `${slug} section present with matching anchor+id`,
      )
    }
  })

  check('a side nav lists every chapter as a #chapter:<slug> link', () => {
    assert.match(html, /<nav class="pf-sidenav" aria-label="Chapters">/, 'pf-sidenav present')
    for (const slug of ['chapter:overview', 'chapter:the-problem', 'chapter:the-solution']) {
      assert.ok(
        html.includes(`class="pf-sidenav-link" href="#${slug}"`),
        `side-nav link to #${slug}`,
      )
    }
  })

  check('blocks and headings nested inside chapters still render + anchor', () => {
    hasBlock(html, 'steps')
    // A step inside "The Problem" chapter, with an accurate line range.
    const map = anchorMap(html)
    // chapters.md:  line 13 ```steps ; line 14 # Investigate the bug ; line 15 edit... ; line 16 ```
    assert.deepEqual(map.anchors['step:investigate-the-bug'].lines, [14, 15])
    // A prose heading inside "The Solution" chapter -> line 20.
    assert.deepEqual(map.anchors['h:a-sub-heading-in-the-solution'].lines, [20, 20])
  })

  check('chapter anchors carry accurate line ranges into plan.md', () => {
    const map = anchorMap(html)
    // Ranges run from the marker line to the chapter's last non-blank line.
    assert.deepEqual(map.anchors['chapter:overview'].lines, [6, 7])
    assert.deepEqual(map.anchors['chapter:the-problem'].lines, [9, 16])
    assert.deepEqual(map.anchors['chapter:the-solution'].lines, [18, 22])
  })

  check('chapters build performs no view-time network fetch', () => {
    assertNoNetworkFetch(html, 'chapters build')
  })
})

// ---------------------------------------------------------------------------
// Fixture: callout.md — all four tones, markdown bodies, anchors.
// ---------------------------------------------------------------------------
fixture('callout.md', (check) => {
  const src = read('callout.md')
  const { html } = renderPlan(src)

  check('callout -> <aside data-block="callout" data-tone="..."> per tone', () => {
    hasBlock(html, 'callout', 4)
    for (const tone of ['info', 'decision', 'warning', 'risk']) {
      assert.match(html, new RegExp(`data-block="callout" data-tone="${tone}"`), `${tone} tone present`)
    }
  })

  check('titled callouts render a .callout-title; bodies render markdown', () => {
    assert.match(html, /class="callout-title">An informational note</, 'info title')
    assert.match(html, /class="callout-title">Careful here</, 'warning title')
    assert.match(html, /<strong>info<\/strong>/, 'markdown bold in body rendered')
  })

  check('each callout carries a callout: anchor (+ matching id)', () => {
    const anchors = [...html.matchAll(/data-block="callout" data-tone="[^"]+" data-pf-anchor="(callout:[^"]+)" id="(callout:[^"]+)"/g)]
    assert.equal(anchors.length, 4, 'four anchored callouts')
    for (const m of anchors) assert.equal(m[1], m[2], 'anchor and id match')
    const map = anchorMap(html)
    assert.ok(Object.keys(map.anchors).some((k) => k.startsWith('callout:')), 'callout anchors in the map')
  })

  check('a remote link inside a callout body does not fetch at view time', () => {
    assertNoNetworkFetch(html, 'callout build')
  })
})

// ---------------------------------------------------------------------------
// Fixture: data-model.md — entity/field cards, flags→change, was:, PK/FK,
// relations, unparseable-line preservation, escaping, anchors + line numbers,
// and title-collision suffixing across two blocks.
// ---------------------------------------------------------------------------
fixture('data-model.md', (check) => {
  const src = read('data-model.md')
  const { html } = renderPlan(src)

  check('data-model -> <figure data-block="data-model"> + figcaption title', () => {
    hasBlock(html, 'data-model', 2)
    assert.match(html, /<figure[^>]*data-block=["']data-model["']/i)
    assert.match(html, /<figcaption[^>]*>Billing schema<\/figcaption>/)
    assert.match(html, /class="dm-grid"/, '.dm-grid present')
  })

  check('ENTITY cards carry data-change from their OWN flag', () => {
    // user is `.` unchanged EVEN THOUGH it has a `~` field (a field flag must not
    // bump the entity's change).
    assert.match(html, /class="dm-entity" data-change="unchanged" data-pf-anchor="data-model:billing-schema:user"/)
    assert.match(html, /class="dm-entity" data-change="added" data-pf-anchor="data-model:billing-schema:plan"/)
    assert.match(html, /class="dm-entity" data-change="deleted" data-pf-anchor="data-model:billing-schema:legacy-tiers"/)
    assert.match(html, /class="dm-entity-name">user</, '.dm-entity-name present')
  })

  check('FIELD rows carry data-change, name + type', () => {
    assert.match(html, /class="dm-field" data-change="modified"[^>]*id="data-model:billing-schema:user-plan-id"/)
    assert.match(html, /class="dm-field" data-change="added"[^>]*id="data-model:billing-schema:user-trial-ends-at"/)
    assert.match(html, /class="dm-field" data-change="unchanged"[^>]*id="data-model:billing-schema:user-email"/)
    assert.match(html, /class="dm-field-name">plan_id<\/span><span class="dm-field-type">uuid</)
  })

  check('was: renders the old value struck-through in .dm-was', () => {
    // plan_id — was: text  -> a .dm-was carrying "text"
    assert.match(html, /class="dm-was">text<\/span>/, '.dm-was for the was: value')
  })

  check('PK/FK badges render, FK shows its -> target', () => {
    assert.match(html, /class="dm-key" data-key="pk">PK</, 'PK badge')
    assert.match(html, /class="dm-key" data-key="fk">FK <span class="dm-fk-target">→ plan\.id<\/span>/, 'FK badge + target')
  })

  check('relations render as a .dm-relations list (no graph layout)', () => {
    assert.match(html, /<ul class="dm-relations">/, '.dm-relations list present')
    assert.match(html, /class="dm-rel-entity">user<\/span><span class="dm-rel-card">}o--\|\|<\/span><span class="dm-rel-entity">plan</)
    assert.match(html, /class="dm-rel-label">belongs to<\/span>/)
    assert.ok(!/class=["'][^"']*\bmermaid\b/.test(html), 'no mermaid graph emitted for relations')
  })

  check('unparseable line is preserved as a muted raw line (never dropped)', () => {
    assert.match(html, /class="dm-raw">\?\?\? not a valid line<\/div>/)
  })

  check('an entity note is HTML-escaped (embedded <script> never live)', () => {
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; dropped/, 'note escaped')
    assert.ok(!/<script>alert\(1\)<\/script>/.test(html), 'no live injected script tag')
  })

  check('block/entity/field anchors carry data-pf-anchor + matching id', () => {
    const anchors = [...html.matchAll(/data-pf-anchor="([^"]+)"/g)].map((m) => m[1])
    for (const a of anchors) {
      assert.ok(html.includes(`data-pf-anchor="${a}" id="${a}"`), `anchor ${a} has matching id`)
    }
    assert.match(html, /data-pf-anchor="data-model:billing-schema"/, 'block anchor')
    assert.match(html, /data-pf-anchor="data-model:billing-schema:user"/, 'entity anchor')
    assert.match(html, /data-pf-anchor="data-model:billing-schema:plan-id"/, 'field anchor')
  })

  check('anchor line numbers are exact (hand-counted in the fixture)', () => {
    const map = anchorMap(html)
    assert.deepEqual(map.anchors['data-model:billing-schema'].lines, [9, 20], 'block fence range')
    assert.equal(map.anchors['data-model:billing-schema'].kind, 'data-model')
    assert.deepEqual(map.anchors['data-model:billing-schema:user'].lines, [10, 10])
    assert.equal(map.anchors['data-model:billing-schema:user'].kind, 'entity')
    assert.deepEqual(map.anchors['data-model:billing-schema:user-plan-id'].lines, [11, 11])
    assert.equal(map.anchors['data-model:billing-schema:user-plan-id'].kind, 'field')
    assert.deepEqual(map.anchors['data-model:billing-schema:plan'].lines, [14, 14])
    assert.deepEqual(map.anchors['data-model:billing-schema:plan-id'].lines, [15, 15])
    assert.deepEqual(map.anchors['data-model:billing-schema:legacy-tiers'].lines, [17, 17])
  })

  check('two blocks sharing a title collide with a :n suffix', () => {
    const map = anchorMap(html)
    assert.ok(map.anchors['data-model:billing-schema:2'], 'second block gets :2')
    assert.deepEqual(map.anchors['data-model:billing-schema:2'].lines, [24, 27])
    assert.deepEqual(map.anchors['data-model:billing-schema:2:invoice'].lines, [25, 25])
    assert.deepEqual(map.anchors['data-model:billing-schema:2:invoice-id'].lines, [26, 26])
    const ids = allIds(html)
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids')
  })

  check('data-model build performs no view-time network fetch', () => {
    assertNoNetworkFetch(html, 'data-model build')
  })
})

// ---------------------------------------------------------------------------
// Fixture: api-endpoint.md — params (in-badges, flags→change, was:), request/
// response sections, server-side JSON trees (nesting + collapse-beyond-depth-2),
// invalid-JSON fallback, escaping, anchors + exact line numbers.
// ---------------------------------------------------------------------------
fixture('api-endpoint.md', (check) => {
  const src = read('api-endpoint.md')
  const { html } = renderPlan(src)

  check('api-endpoint -> <figure data-block="api-endpoint"> with head', () => {
    hasBlock(html, 'api-endpoint')
    assert.match(html, /<figcaption[^>]*>Create upload<\/figcaption>/)
    assert.match(html, /class="api-method" data-method="POST">POST</, 'method badge (upper-cased)')
    assert.match(html, /class="api-path">\/v2\/uploads</, 'path rendered')
  })

  check('missing method/path degrades gracefully (no badge/path, still renders)', () => {
    const { html: h2 } = renderPlan('---\ntitle: T\n---\n\n```api-endpoint\n. auth token\n```\n')
    hasBlock(h2, 'api-endpoint')
    assert.ok(!/class="api-method"/.test(h2), 'no method badge when method missing')
    assert.ok(!/class="api-path"/.test(h2), 'no path when path missing')
  })

  check('PARAM rows: in-badge + flag→change; auth free text preserved', () => {
    assert.match(html, /class="api-param" data-change="unchanged"[^>]*id="api-endpoint:post-v2-uploads:auth"/)
    assert.match(html, /class="api-param" data-change="added"[^>]*id="api-endpoint:post-v2-uploads:expires-in"/)
    assert.match(html, /class="api-param" data-change="modified"[^>]*id="api-endpoint:post-v2-uploads:name"/)
    assert.match(html, /class="api-param" data-change="deleted"[^>]*id="api-endpoint:post-v2-uploads:x-legacy"/)
    for (const inKind of ['auth', 'query', 'body', 'header']) {
      assert.match(html, new RegExp(`class="api-in" data-in="${inKind}">${inKind}<`), `api-in badge ${inKind}`)
    }
    assert.match(html, /class="api-param-name">Bearer org token</, 'auth free text preserved')
    assert.match(html, /class="api-param-name">expires_in<\/span><span class="api-param-type">int</)
  })

  check('was: renders struck; a bad param line is a muted raw line', () => {
    assert.match(html, /class="api-was">user token<\/span>/, 'auth was: value')
    assert.match(html, /class="api-raw-line">! not a param line<\/div>/, 'raw param preserved')
  })

  check('sections: request + response<code> with .api-code badge', () => {
    assert.match(html, /class="api-section" data-section="request"[^>]*id="api-endpoint:post-v2-uploads:request"/)
    assert.match(html, /class="api-section" data-section="response" data-code="201"[^>]*id="api-endpoint:post-v2-uploads:resp-201"/)
    assert.match(html, /class="api-section" data-section="response" data-code="413"/)
    assert.match(html, /class="api-code">REQUEST</, 'request badge')
    assert.match(html, /class="api-code">201</, 'response code badge')
  })

  check('JSON tree: nested <details>, top-level open, collapsed beyond depth 2', () => {
    assert.match(html, /class="json-tree"/, '.json-tree present')
    assert.match(html, /<details class="json-node" data-depth="0" open>/, 'top-level open')
    assert.match(html, /<details class="json-node" data-depth="1" open>/, 'depth 1 open')
    assert.match(html, /<details class="json-node" data-depth="2" open>/, 'depth 2 open')
    // depth 3 container is collapsed (no ` open`).
    assert.match(html, /<details class="json-node" data-depth="3">/, 'depth 3 collapsed')
    assert.ok(!/<details class="json-node" data-depth="3" open>/.test(html), 'depth 3 must NOT be open')
    assert.match(html, /class="json-value json-number">1</, 'number value styled')
    assert.match(html, /class="json-key">meta<\/span>/, 'object key rendered')
  })

  check('a JSON string value is HTML-escaped (embedded <script> never live)', () => {
    assert.match(html, /class="json-value json-string">&quot;&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;</)
    assert.ok(!/<script>alert\(1\)<\/script>/.test(html), 'no live injected script tag')
  })

  check('invalid JSON falls back to <pre class="api-raw"> with a hint', () => {
    assert.match(html, /<pre class="api-raw"><span class="api-raw-hint">not valid JSON<\/span>not json at all<\/pre>/)
  })

  check('param + section anchors carry data-pf-anchor + matching id', () => {
    const anchors = [...html.matchAll(/data-pf-anchor="([^"]+)"/g)].map((m) => m[1])
    for (const a of anchors) {
      assert.ok(html.includes(`data-pf-anchor="${a}" id="${a}"`), `anchor ${a} has matching id`)
    }
  })

  check('anchor line numbers are exact (hand-counted in the fixture)', () => {
    const map = anchorMap(html)
    assert.deepEqual(map.anchors['api-endpoint:post-v2-uploads'].lines, [9, 21], 'block fence range')
    assert.equal(map.anchors['api-endpoint:post-v2-uploads'].kind, 'api-endpoint')
    assert.deepEqual(map.anchors['api-endpoint:post-v2-uploads:auth'].lines, [10, 10])
    assert.equal(map.anchors['api-endpoint:post-v2-uploads:auth'].kind, 'param')
    assert.deepEqual(map.anchors['api-endpoint:post-v2-uploads:expires-in'].lines, [11, 11])
    assert.deepEqual(map.anchors['api-endpoint:post-v2-uploads:x-legacy'].lines, [13, 13])
    assert.deepEqual(map.anchors['api-endpoint:post-v2-uploads:request'].lines, [15, 15])
    assert.equal(map.anchors['api-endpoint:post-v2-uploads:request'].kind, 'request')
    assert.deepEqual(map.anchors['api-endpoint:post-v2-uploads:resp-201'].lines, [17, 17])
    assert.equal(map.anchors['api-endpoint:post-v2-uploads:resp-201'].kind, 'response')
    assert.deepEqual(map.anchors['api-endpoint:post-v2-uploads:resp-413'].lines, [19, 19])
  })

  check('unique ids across the whole block', () => {
    const ids = allIds(html)
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids')
  })

  check('api-endpoint build performs no view-time network fetch', () => {
    assertNoNetworkFetch(html, 'api-endpoint build')
  })
})

// ---------------------------------------------------------------------------
// Regression: prose heading + paragraph anchors (inline source, no fixture).
// ---------------------------------------------------------------------------
fixture('<regression: prose anchors & collisions>', (check) => {
  check('headings and paragraphs get content-derived anchors', () => {
    const src = '---\ntitle: T\n---\n\n## The First Section\n\nA short paragraph of prose here.\n'
    const { html } = renderPlan(src)
    assert.match(html, /<h2 data-pf-anchor="h:the-first-section" id="h:the-first-section">/)
    assert.match(html, /<p data-pf-anchor="p:a-short-paragraph-of-prose[^"]*" id="p:a-short-paragraph-of-prose/)
    const map = anchorMap(html)
    // Heading line resolves via source scan (frontmatter counted -> line 5).
    assert.deepEqual(map.anchors['h:the-first-section'].lines, [5, 5])
    // Paragraph lines are contractually null.
    const pKey = Object.keys(map.anchors).find((k) => k.startsWith('p:a-short-paragraph'))
    assert.equal(map.anchors[pKey].lines, null)
  })

  check('duplicate step titles get :n collision suffixes in document order', () => {
    const src = '---\ntitle: T\n---\n\n```steps\n# Same title\nedit a — x\n# Same title\nedit b — y\n```\n'
    const { html } = renderPlan(src)
    const stepAnchors = [...html.matchAll(/li class="step" data-pf-anchor="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(stepAnchors, ['step:same-title', 'step:same-title:2'])
    // Both are unique ids.
    const ids = allIds(html)
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids under collision')
  })

  check('duplicate headings collide deterministically', () => {
    const src = '---\ntitle: T\n---\n\n## Repeat\n\ntext one\n\n## Repeat\n\ntext two\n'
    const { html } = renderPlan(src)
    assert.match(html, /id="h:repeat"/)
    assert.match(html, /id="h:repeat:2"/)
  })
})

// ---------------------------------------------------------------------------
// Fixture: list-items.md — prose list items (ul + ol + nested) get kind `li`
// anchors, with collision suffixing, while a steps block's items keep kind
// `step` (no double-anchoring). The annotation layer is generic over
// [data-pf-anchor], so pinning a note on an individual bullet now resolves to
// that <li> rather than the whole enclosing chapter/paragraph.
// ---------------------------------------------------------------------------
fixture('list-items.md', (check) => {
  const src = read('list-items.md')
  const { html } = renderPlan(src)
  const map = anchorMap(html)
  const liKeys = Object.keys(map.anchors).filter((k) => map.anchors[k].kind === 'li')

  check('every prose <li> carries data-pf-anchor + matching id', () => {
    // Marked emits bare <li> for prose; after tagging none should be left bare
    // (block <li> already carry class="step"/"tree-row" + their own anchor).
    assert.ok(!/<li>/.test(html), 'no prose <li> left without an anchor')
    for (const m of html.matchAll(/<li data-pf-anchor="([^"]+)" id="([^"]+)">/g)) {
      assert.equal(m[1], m[2], 'data-pf-anchor and id agree on each <li>')
      assert.match(m[1], /^li:/, 'prose list items use the `li` kind prefix')
    }
  })

  check('ul, ol and nested items are all anchored with sensible slugs', () => {
    for (const a of [
      'li:alpha-finding-here',   // <ul> item
      'li:beta-finding-here',    // <ul> item
      'li:first-numbered-step',  // <ol> item
      'li:second-numbered-step', // <ol> item
      'li:parent-topic',         // parent of a nested list — own text only, no child bleed
      'li:child-detail-one',     // nested <ul> item
      'li:child-detail-two',     // nested <ul> item
    ]) {
      assert.ok(map.anchors[a], `expected anchor ${a}`)
      assert.equal(map.anchors[a].kind, 'li', `${a} is kind li`)
      assert.equal(map.anchors[a].lines, null, `${a} lines are contractually null`)
    }
    // Label is the item's first ~6 words of text.
    assert.equal(map.anchors['li:parent-topic'].label, 'Parent topic')
  })

  check('two identical items collide with a :2 suffix in document order', () => {
    assert.ok(map.anchors['li:duplicate-line-text'], 'first duplicate item')
    assert.ok(map.anchors['li:duplicate-line-text:2'], 'second duplicate item gets :2')
    const order = liKeys.filter((k) => k.startsWith('li:duplicate-line-text'))
    assert.deepEqual(order, ['li:duplicate-line-text', 'li:duplicate-line-text:2'])
  })

  check("a steps block's items stay kind `step`, never `li`", () => {
    assert.equal(map.anchors['step:wire-the-guard'].kind, 'step')
    assert.equal(map.anchors['step:wire-the-guard:2'].kind, 'step')
    // No li: anchor ever lands on a rendered block's <li class="step"> row.
    assert.ok(
      !/class="step"[^>]*data-pf-anchor="li:/.test(html) &&
        !/data-pf-anchor="li:[^"]*"[^>]*class="step"/.test(html),
      'steps <li class="step"> rows are not double-anchored as `li`',
    )
    // Every li: anchor came from prose, not from a step title.
    assert.ok(
      !liKeys.some((k) => /wire-the-guard/.test(k)),
      'no prose `li` anchor derived from a step title',
    )
  })

  check('all anchor ids are unique across the page', () => {
    const ids = allIds(html)
    const dupes = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))]
    assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`)
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
  const exercised = ['all-blocks.md', 'api-endpoint.md', 'callout.md', 'chapters.md', 'data-model.md', 'empty.md', 'full-plan.md', 'grouping.md', 'list-items.md', 'unknown-block.md'].sort()
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
// SKILL.md frontmatter: strict-YAML portability.
//
// Claude Code's loader is lenient, but the skills.sh CLI (`npx skills add`)
// parses frontmatter with the strict `yaml` package and silently drops any
// skill whose frontmatter throws — the repo then installs as "No valid skills
// found". Our house style is single-line plain scalars, so every value must
// avoid the plain-scalar killers: `: ` (starts a nested mapping) and ` #`
// (starts a comment), plus YAML indicator chars in leading position. A value
// passing these rules parses identically under strict YAML and under naive
// line-regex parsers — which is the whole portability story.
// ---------------------------------------------------------------------------
fixture('SKILL.md frontmatter (strict-YAML portability)', (check) => {
  const skillsRoot = join(__dirname, '..', '..', '..')
  const YAML_INDICATORS = /^[-?:,\[\]{}#&*!|>'"%@`]/
  for (const dir of ['present', 'present-plan', 'present-recap']) {
    const path = join(skillsRoot, dir, 'SKILL.md')
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      continue // adapter dirs absent in a CLI-installed copy; repo layout has all three
    }
    check(`${dir}: frontmatter block present and single-line plain scalars only`, () => {
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
      assert.ok(m, 'file must open with a --- frontmatter block')
      const fields = {}
      let inMetadata = false
      for (const line of m[1].split(/\r?\n/)) {
        if (!line.trim()) continue
        if (/^\s+/.test(line)) {
          assert.ok(inMetadata, `unexpected continuation line (multi-line values break naive parsers): ${line}`)
          continue
        }
        inMetadata = false
        const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s(.*))?$/)
        assert.ok(kv, `frontmatter line must be "key: value": ${line}`)
        const [, key, value = ''] = kv
        if (value === '') { inMetadata = true; continue } // nested block (e.g. metadata:)
        assert.ok(!value.includes(': '), `${key}: contains ": " — strict YAML reads a nested mapping and the skills CLI drops the skill`)
        assert.ok(!value.includes(' #'), `${key}: contains " #" — strict YAML truncates it as a comment`)
        assert.ok(!YAML_INDICATORS.test(value), `${key}: starts with a YAML indicator char — quote-free plain scalar required`)
        assert.ok(!value.endsWith(':'), `${key}: ends with ":" — strict YAML reads a nested mapping`)
        fields[key] = value
      }
      assert.equal(fields.name, dir, 'name must match the skill directory')
      assert.ok(/^[a-z0-9-]{1,64}$/.test(fields.name), 'name must be lowercase-hyphen, ≤64 chars')
      assert.ok(fields.description, 'description is required')
      assert.ok([...fields.description].length <= 1024, `description is ${[...fields.description].length} chars (max 1024)`)
    })
  }
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
