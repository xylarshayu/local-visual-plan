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
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { renderPlan, extractIsland, extractPrevVersion, EMBED_CSP } from '../render.mjs'

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

/** Strict: no external URL token anywhere, except where a reader clicks: an <a href>. */
function assertNoExternalUrl(html, where) {
  const offenders = []
  html = html.replace(/<a\b[^>]*>/gi, (tag) => tag.replace(/\shref\s*=\s*(["'])[^"']*\1/i, ''))
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
  // A link the reader clicks (<a href>) is not a load; every other remote src/href is.
  const remoteAttr = /<([a-z][\w-]*)\b[^>]*?\b(?:src|href)\s*=\s*["'](?:https?:)?\/\/[^"']+["']/gi
  for (const m of html.matchAll(remoteAttr)) if (m[1].toLowerCase() !== 'a') offenders.push('remote attr: ' + m[0])

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
    // Two authored questions -> two radio groups; NOTHING is pre-selected —
    // an explicit "Accept default" click is a deliberate answer, while an
    // untouched question still exports its accepted default.
    assert.match(html, /<input type="radio" name="q:[^"]+" value="default">/, 'default radio present')
    assert.ok(!/value="default" checked/.test(html), 'no radio is pre-checked')
    assert.match(html, /<input type="radio" name="q:[^"]+" value="custom">/, 'custom radio present')
    assert.match(html, /<textarea class="q-note"/, '.q-note answer-note textarea present')
    // The radio group name matches the question's own anchor.
    const qAnchor = (html.match(/class="question" data-pf-anchor="(q:[^"]+)"/) || [])[1]
    assert.ok(qAnchor, 'question carries a q: anchor')
    assert.ok(count(html, `name="${qAnchor}"`) >= 2, 'both radios share the question anchor as name')
  })

  check('agent-offered option: lines render as radios with captions + opt anchors', () => {
    const r = renderPlan(
      '---\ntitle: T\n---\n\n```questions\n# Ship behind a flag?\ndefault: Yes.\noption: No flag — simplest, but risky rollback\noption: Gradual rollout\n```\n',
    )
    assert.match(r.html, /<input type="radio" name="q:ship-behind-a-flag" value="option" data-opt="No flag">/, 'option radio carries its label in data-opt')
    assert.match(r.html, /<span class="q-opt-label">No flag<\/span><span class="q-opt-caption">simplest, but risky rollback<\/span>/, 'caption rendered')
    assert.match(r.html, /<span class="q-opt-label">Gradual rollout<\/span>/, 'caption-less option renders label only')
    const opt = r.anchors['q:ship-behind-a-flag:opt-no-flag']
    assert.ok(opt && opt.kind === 'opt', 'option registered as child anchor (kind opt)')
    assert.ok(!/<input[^>]*value="option"[^>]*checked/.test(r.html), 'options are not pre-checked either')
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

  check('inside a git repo, "source" is repo-relative and no local path ships in the page', () => {
    const { html: h2 } = renderPlan(src, { sourcePath: join(FIXTURES, 'all-blocks.md') })
    assert.equal(anchorMap(h2).source, 'skills/present/renderer/test/fixtures/all-blocks.md')
    assert.ok(!h2.includes(FIXTURES), 'the absolute fixtures path is nowhere in the page')
  })

  check('with no frontmatter title, a leading # H1 is the title, printed once, line numbers kept', () => {
    const md = '\n# Sync, end to end\n\nIntro.\n\n```callout\nBody.\n```\n'
    const { html: h2, slug } = renderPlan(md)
    assert.equal(slug, 'sync-end-to-end')
    assert.equal(anchorMap(h2).title, 'Sync, end to end')
    assert.deepEqual(h2.match(/<h1\b[^>]*>[^<]*/g), ['<h1 class="plan-title">Sync, end to end'], 'one h1: the page title, not the body H1 again')
    assert.deepEqual(anchorMap(h2).anchors['callout:info-1'].lines, [6, 8], 'a block after the H1 keeps its source lines')
    const kept = renderPlan('---\ntitle: Front\n---\n# Body H1\n')
    assert.equal(anchorMap(kept.html).title, 'Front')
    assert.match(kept.html, /<h1[^>]*>Body H1<\/h1>/, 'with a frontmatter title the H1 stays in the body')
    assert.equal(anchorMap(renderPlan('Intro.\n\n# Later H1\n').html).title, 'Untitled plan', 'only a leading H1 is the title')
  })

  check('a relative link to a sibling .md becomes .html; other links are left alone', () => {
    const { html: h2 } = renderPlan('---\ntitle: T\n---\n[a](ch2.md) [b](./ch3.md#sync) [c](../other/ch4.md) [d](docs/x.md) [e](https://x.org/r.md) [f](notes.mdx)\n')
    const hrefs = [...h2.matchAll(/<a\b[^>]*?href="([^"]*)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('#'))
    assert.deepEqual(hrefs, ['ch2.html', 'ch3.html#sync', '../other/ch4.md', 'docs/x.md', 'https://x.org/r.md', 'notes.mdx'])
  })

  check('a link to another site stays a real link that opens in a new tab; a remote image still never loads', () => {
    const { html: h2 } = renderPlan('---\ntitle: T\n---\nSee [the docs](https://www.example.org/docs/api?x=1&y=2), [cdn](//cdn.example.org/a), [here](#top) and ![logo](https://img.example.org/l.png).\n\n```callout\nAlso [in a callout](https://example.org/c).\n```\n')
    const prose = h2.slice(h2.indexOf('See '))
    assert.match(prose, /<a href="https:\/\/www\.example\.org\/docs\/api\?x=1&y=2" target="_blank" rel="noopener">the docs<\/a>/)
    assert.match(prose, /<a href="https:\/\/cdn\.example\.org\/a" target="_blank" rel="noopener">cdn<\/a>/, 'a protocol-relative link gets https, not file:')
    assert.match(prose, /<a href="#top">here<\/a>/, 'an in-page link is untouched')
    assert.match(h2, /<a href="https:\/\/example\.org\/c" target="_blank" rel="noopener">in a callout<\/a>/)
    assert.doesNotMatch(h2, /data-external-href|disabled offline/)
    assert.doesNotMatch(h2, /<img[^>]*img\.example\.org/)
    assert.match(h2, /<span class="ext-img-placeholder" data-external-src="img\.example\.org\/l\.png">logo<\/span>/)
    assertNoNetworkFetch(h2, 'remote links')
    assert.throws(() => assertNoNetworkFetch(h2.replace('<span class="ext-img-placeholder"', '<img src="https://img.example.org/l.png"><span'), 'planted'), /remote attr/, 'a remote img is still caught')
    assert.throws(() => assertNoNetworkFetch('<link rel="stylesheet" href="https://x.org/s.css">', 'planted'), /remote attr/, 'a remote stylesheet is still caught')
    const raw = renderPlan('---\ntitle: T\n---\n<a href="https://example.org/r" target="_self">raw</a>\n').html
    assert.match(raw, /<a href="https:\/\/example\.org\/r" target="_self">raw<\/a>/, 'an author\'s own target is kept')
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
    assert.match(html, /class="api-code">Request</, 'request badge')
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
// Fixture: task-list.md — GFM task-list items ("- [ ]" / "- [x]") get kind
// `task` anchors (distinct from a plain prose `li`) and render their checkbox
// ENABLED (no `disabled` attribute), with the source-authored checked state
// preserved as-is — the client-side layer (annotate.js) is what later applies
// any stored override on top of this at boot. Collision suffixing, nesting,
// and adjacency to a plain (non-task) list all reuse the same `li` machinery
// list-items.md already covers, so this fixture only asserts what's NEW.
// ---------------------------------------------------------------------------
fixture('task-list.md', (check) => {
  const src = read('task-list.md')
  const { html } = renderPlan(src)
  const map = anchorMap(html)

  check('every checkbox renders enabled (no disabled attribute)', () => {
    assert.ok(!/<input[^>]*\bdisabled/i.test(html), 'no disabled checkbox anywhere in the page')
    assert.ok(/<input type="checkbox">/.test(html), 'unchecked box renders as a plain enabled checkbox')
    assert.ok(/<input checked="" type="checkbox">/.test(html), 'checked box keeps checked="" and is still enabled')
  })

  check('task items get kind `task`, never `li`', () => {
    for (const a of [
      'task:unchecked-item-one',
      'task:checked-item-two',
      'task:parent-task-with-a-child',
      'task:child-task-one',
      'task:child-task-two',
    ]) {
      assert.ok(map.anchors[a], `expected anchor ${a}`)
      assert.equal(map.anchors[a].kind, 'task', `${a} is kind task`)
      assert.equal(map.anchors[a].lines, null, `${a} lines are contractually null, same as li/p`)
    }
  })

  check('a plain bullet list next to task items stays kind `li`, unaffected', () => {
    assert.equal(map.anchors['li:plain-bullet-one'].kind, 'li')
    assert.equal(map.anchors['li:plain-bullet-two'].kind, 'li')
    assert.ok(!Object.keys(map.anchors).some((k) => k.startsWith('task:plain-bullet')), 'plain bullets never get a task: anchor')
  })

  check('label is the fuller item text (not the 6-word slug a plain `li` keeps)', () => {
    const long = map.anchors['task:a-rather-long-unchecked-item-that']
    assert.ok(long, 'expected the long item to have registered under its 6-word slug')
    assert.ok(long.label.length > 'A rather long unchecked item'.length, 'label is fuller than the id slug')
    assert.ok(long.label.endsWith('…'), 'label truncates with an ellipsis past 80 chars')
    assert.equal(map.anchors['task:checked-item-two'].label, 'Checked item two', 'a short label is not padded/altered')
  })

  check('duplicate task text collides with a :2 suffix, in document order', () => {
    assert.ok(map.anchors['task:duplicate-task-text'])
    assert.ok(map.anchors['task:duplicate-task-text:2'])
    const order = Object.keys(map.anchors).filter((k) => k.startsWith('task:duplicate-task-text'))
    assert.deepEqual(order, ['task:duplicate-task-text', 'task:duplicate-task-text:2'])
  })

  check('a nested task under a task parent gets its own distinct anchor (not swallowed by the parent)', () => {
    assert.notEqual(map.anchors['task:parent-task-with-a-child'], map.anchors['task:child-task-one'])
    // The parent's own <li> markup only carries ITS OWN checkbox, not the child's,
    // between its opening tag and the nested <ul> — verifies the parent didn't
    // slurp the child's checkbox/text into its own label.
    const parentLi = html.match(/<li data-pf-anchor="task:parent-task-with-a-child"[^>]*>([\s\S]*?)<ul>/)
    assert.ok(parentLi, 'parent <li> found with a nested <ul> after its own content')
    assert.equal((parentLi[1].match(/<input/g) || []).length, 1, 'parent li content (before the nested <ul>) has exactly one checkbox — its own')
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
  const exercised = ['all-blocks.md', 'api-endpoint.md', 'callout.md', 'chapters.md', 'data-model.md', 'embed.md', 'empty.md', 'full-plan.md', 'grouping.md', 'list-items.md', 'stepper.md', 'composite.md', 'task-list.md', 'unknown-block.md'].sort()
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
// Granular anchors: prose tables (table / row / cell), plain code fences,
// step file lines, data-model relations.
// ---------------------------------------------------------------------------
fixture('granular anchors: prose tables', (check) => {
  const src =
    '---\ntitle: T\n---\n\n' +
    '| Feature | Cost | Notes |\n' +
    '| --- | --- | --- |\n' +
    '| Upload guard | low | reuses the client |\n' +
    '| Chunking | high | deferred |\n'
  const { html, anchors } = renderPlan(src)

  check('table itself is anchored (kind table, slug from headers)', () => {
    assert.match(html, /<table data-pf-anchor="table:feature-cost-notes" id="table:feature-cost-notes">/)
    assert.equal(anchors['table:feature-cost-notes'].kind, 'table')
    assert.equal(anchors['table:feature-cost-notes'].label, 'Feature · Cost · Notes')
  })
  check('each body row is a child anchor of the table (kind row)', () => {
    assert.match(html, /<tr data-pf-anchor="table:feature-cost-notes:upload-guard" id="table:feature-cost-notes:upload-guard">/)
    assert.match(html, /<tr data-pf-anchor="table:feature-cost-notes:chunking" id="table:feature-cost-notes:chunking">/)
    assert.equal(anchors['table:feature-cost-notes:upload-guard'].kind, 'row')
  })
  check('each body cell is a child anchor of its row, slugged by column header', () => {
    const cell = anchors['table:feature-cost-notes:upload-guard:cost']
    assert.ok(cell, 'cell anchor registered')
    assert.equal(cell.kind, 'cell')
    assert.equal(cell.label, 'Cost: low')
    assert.match(html, /<td data-pf-anchor="table:feature-cost-notes:upload-guard:cost" id="table:feature-cost-notes:upload-guard:cost">low<\/td>/)
  })
  check('header row (thead) cells stay unanchored', () => {
    assert.ok(!/<th[^>]*data-pf-anchor/.test(html), 'no anchors on th')
  })
  check('diff tables keep their own anchor scheme (no table/row/cell kinds)', () => {
    const d = renderPlan('---\ntitle: T\n---\n\n```diff file=a.ts\n@@ -1 +1 @@\n-a\n+b\n```\n')
    assert.ok(!Object.values(d.anchors).some((a) => a.kind === 'table' || a.kind === 'row' || a.kind === 'cell'))
  })
  check('duplicate row leads get collision-suffixed anchors', () => {
    const d = renderPlan('---\ntitle: T\n---\n\n| A |\n| --- |\n| same |\n| same |\n')
    const rows = Object.keys(d.anchors).filter((a) => d.anchors[a].kind === 'row')
    assert.equal(rows.length, 2)
    assert.notEqual(rows[0], rows[1])
  })
})

fixture('granular anchors: code fences, step files, dm relations', (check) => {
  check('plain fenced code block gets a kind pre anchor; custom blocks untouched', () => {
    const { html, anchors } = renderPlan(
      '---\ntitle: T\n---\n\n```js\nconst answer = 42\n```\n\n```code lang=ts\nlet x = 1\n```\n',
    )
    const pres = Object.keys(anchors).filter((a) => anchors[a].kind === 'pre')
    assert.equal(pres.length, 1, 'exactly one pre anchor (the ```js fence)')
    assert.equal(anchors[pres[0]].label, 'js · const answer = 42')
    assert.match(html, new RegExp(`<pre data-pf-anchor="${pres[0]}" id="${pres[0]}"><code class="language-js">`))
    // the custom code block still uses its own kind
    assert.ok(Object.values(anchors).some((a) => a.kind === 'code'))
  })
  check('mermaid/diagram/unknown pres are not re-anchored', () => {
    const { html } = renderPlan('---\ntitle: T\n---\n\n```diagram\nflowchart LR\n  A-->B\n```\n')
    assert.ok(!/<pre data-pf-anchor="pre:/.test(html))
  })
  check('each step file line is a child anchor (kind file) of its step', () => {
    const { html, anchors } = renderPlan(
      '---\ntitle: T\n---\n\n```steps\n# Add the guard\nreuse src/lib/client.ts — client is fine\nedit src/actions/upload.ts — add the check\n```\n',
    )
    const a = 'step:add-the-guard:src-actions-upload-ts'
    assert.ok(anchors[a], 'file child anchor registered under the step')
    assert.equal(anchors[a].kind, 'file')
    assert.equal(anchors[a].label, 'edit src/actions/upload.ts')
    assert.match(html, new RegExp(`<li data-change="edit" data-pf-anchor="${a}" id="${a}">`))
    assert.ok(anchors[a].lines, 'file line carries a real plan.md line')
  })
  check('data-model relation lines are child anchors (kind relation)', () => {
    const { html, anchors } = renderPlan(
      '---\ntitle: T\n---\n\n```data-model title=DM\n. user\n.   id uuid PK\n. plan\n.   id uuid PK\nuser ||--o{ plan : owns\n```\n',
    )
    const a = 'data-model:dm:rel-user-plan'
    assert.ok(anchors[a], 'relation anchor registered')
    assert.equal(anchors[a].kind, 'relation')
    assert.equal(anchors[a].label, 'user ||--o{ plan : owns')
    assert.match(html, new RegExp(`<li class="dm-relation" data-pf-anchor="${a}" id="${a}">`))
  })
})

// ---------------------------------------------------------------------------
// Change detection: re-render vs a previous source marks edited/new elements,
// bakes a pf-changes island, and leaves moved-but-identical content unmarked.
// ---------------------------------------------------------------------------
fixture('change detection (prevSource diff)', (check) => {
  // The second paragraph shares its first six words (the slug window) across
  // versions, so its anchor id is stable and the diff reads as an EDIT; a
  // paragraph whose leading words change gets a new id and reads as NEW —
  // still highlighted, just labeled differently.
  const v1 =
    '---\ntitle: T\n---\n\n' +
    '## Approach\n\n' +
    'First paragraph stays the same.\n\n' +
    'Second paragraph is quite long and will be edited later.\n\n' +
    '```steps\n# Add the guard\nedit src/upload.ts — add the check\n```\n'
  const v2 =
    '---\ntitle: T\n---\n\n' +
    '## Approach\n\n' +
    'First paragraph stays the same.\n\n' +
    'Second paragraph is quite long and was edited right here.\n\n' +
    'A brand new paragraph.\n\n' +
    '```steps\n# Add the guard\nedit src/upload.ts — add the check\n```\n'

  check('anchor map entries carry content signatures', () => {
    const { anchors } = renderPlan(v1)
    assert.ok(Object.values(anchors).every((a) => !('sig' in a) || /^[0-9a-f]{8}$/.test(a.sig)))
    assert.ok(anchors['h:approach'].sig, 'headings are signed')
    assert.ok(anchors['step:add-the-guard'].sig, 'steps are signed')
  })
  check('no prevSource (or identical source) -> no pf-changes island, no marks', () => {
    const a = renderPlan(v1)
    assert.ok(!a.html.includes('id="pf-changes"'))
    assert.equal(a.changes, null)
    const b = renderPlan(v1, { prevSource: v1 })
    assert.ok(!b.html.includes('id="pf-changes"'))
  })
  check('edited element is marked data-pf-changed="edited"', () => {
    const { html } = renderPlan(v2, { prevSource: v1 })
    assert.match(html, /data-pf-anchor="p:second-paragraph-is-quite-long-and" id="p:second-paragraph-is-quite-long-and" data-pf-changed="edited"/)
  })
  check('new element is marked data-pf-changed="new"', () => {
    const { html } = renderPlan(v2, { prevSource: v1 })
    assert.match(html, /data-pf-anchor="p:a-brand-new-paragraph" id="p:a-brand-new-paragraph" data-pf-changed="new"/)
  })
  check('unchanged and moved-verbatim elements are NOT marked', () => {
    const { html, changes } = renderPlan(v2, { prevSource: v1 })
    assert.ok(!/p:first-paragraph-stays-the-same" data-pf-changed/.test(html), 'unchanged paragraph unmarked')
    assert.ok(!changes.changed.some((c) => c.anchor === 'step:add-the-guard'), 'untouched step not a change')
    // move the untouched step earlier: content identical -> still no mark
    const v3 =
      '---\ntitle: T\n---\n\n```steps\n# Add the guard\nedit src/upload.ts — add the check\n```\n\n## Approach\n\nFirst paragraph stays the same.\n\nSecond paragraph is quite long and will be edited later.\n'
    const moved = renderPlan(v3, { prevSource: v1 })
    assert.ok(!moved.changes.changed.some((c) => c.anchor.startsWith('step:')), 'moved-verbatim step not a change')
  })
  check('pf-changes island lists changes and removals with prevDocId', () => {
    const { html, changes } = renderPlan(v2, { prevSource: v1 })
    const m = /<script type="application\/json" id="pf-changes">([\s\S]*?)<\/script>/.exec(html)
    assert.ok(m, 'island present')
    const parsed = JSON.parse(m[1])
    assert.equal(parsed.prevDocId, renderPlan(v1).docId)
    assert.deepEqual(parsed.changes, changes.changed)
    // removal: drop the second paragraph entirely
    const v4 = v1.replace('Second paragraph is quite long and will be edited later.\n\n', '')
    const rem = renderPlan(v4, { prevSource: v1 })
    assert.ok(rem.changes.removed.some((r) => r.anchor === 'p:second-paragraph-is-quite-long-and'))
  })
})

// ---------------------------------------------------------------------------
// Version history: renderedAt in the anchor map, the pf-history island
// (creation, entry shape, chaining across renders, and the 8-entry cap).
// ---------------------------------------------------------------------------
fixture('history island & renderedAt', (check) => {
  const v1 =
    '---\ntitle: T\n---\n\n' +
    'Alpha paragraph in version one.\n\n' +
    'Shared closing paragraph stays put.\n'
  const v2 =
    '---\ntitle: T\n---\n\n' +
    'Beta paragraph replaces the alpha one.\n\n' +
    'Shared closing paragraph stays put.\n'
  const v3 =
    '---\ntitle: T\n---\n\n' +
    'Gamma paragraph replaces the beta one.\n\n' +
    'Shared closing paragraph stays put.\n'

  check('anchor map carries a renderedAt ISO timestamp', () => {
    const { html } = renderPlan(v1)
    const map = extractIsland(html, 'pf-anchor-map')
    assert.ok(map, 'anchor map island parses')
    assert.equal(typeof map.renderedAt, 'string', 'renderedAt is a string')
    const t = Date.parse(map.renderedAt)
    assert.ok(Number.isFinite(t), 'renderedAt parses as a date')
    // Full ISO round-trip: toISOString() output parses back to the same instant.
    assert.equal(new Date(t).toISOString(), map.renderedAt, 'renderedAt is canonical ISO 8601')
  })

  check('first render (no prevSource) has no pf-history island', () => {
    const { html } = renderPlan(v1)
    assert.ok(!html.includes('id="pf-history"'), 'no pf-history island on a first render')
    assert.equal(extractIsland(html, 'pf-history'), null, 'extractIsland returns null when absent')
  })

  const page2 = renderPlan(v2, { prevSource: v1, prevRenderedAt: '2026-07-10T12:00:00.000Z' })
  const hist2 = extractIsland(page2.html, 'pf-history')

  check('re-render with prevSource bakes a one-entry history island', () => {
    assert.ok(hist2, 'pf-history island present and parseable')
    assert.equal(hist2.version, 1)
    assert.ok(Array.isArray(hist2.entries), 'entries is an array')
    assert.equal(hist2.entries.length, 1, 'exactly one entry after the first re-render')
    assert.equal(hist2.entries[0].docId, renderPlan(v1).docId, "entry.docId is the PREVIOUS version's docId")
    assert.equal(hist2.entries[0].renderedAt, '2026-07-10T12:00:00.000Z', 'entry carries the passed prevRenderedAt')
  })

  check('history anchors keep kind/label (+8-hex sig), and NEVER lines', () => {
    const anchors = hist2.entries[0].anchors
    const keys = Object.keys(anchors)
    assert.ok(keys.length > 0, 'entry has anchors')
    for (const a of keys) {
      assert.equal(typeof anchors[a].kind, 'string', `${a}.kind is a string`)
      assert.equal(typeof anchors[a].label, 'string', `${a}.label is a string`)
      assert.ok(!('lines' in anchors[a]), `${a} must not carry lines in history`)
      if ('sig' in anchors[a]) assert.match(anchors[a].sig, /^[0-9a-f]{8}$/, `${a}.sig is 8 hex chars`)
    }
    assert.ok(keys.some((a) => anchors[a].sig), 'at least one history anchor is signed')
  })

  check('history chains: v3 over v2 prepends the newest entry first', () => {
    const page3 = renderPlan(v3, { prevSource: v2, prevHistory: hist2.entries })
    const hist3 = extractIsland(page3.html, 'pf-history')
    assert.ok(hist3, 'chained pf-history island present')
    assert.equal(hist3.entries.length, 2, 'two entries after two re-renders')
    assert.equal(hist3.entries[0].docId, renderPlan(v2).docId, "newest entry (v2's docId) comes first")
    assert.equal(hist3.entries[1].docId, renderPlan(v1).docId, "v1's entry carried forward behind it")
  })

  check('history is capped at 8 entries total', () => {
    const dummies = Array.from({ length: 10 }, (_, i) => ({
      docId: `pf-00000000000${i.toString(16)}`.slice(0, 15),
      renderedAt: null,
      anchors: {},
    }))
    const { html } = renderPlan(v3, { prevSource: v2, prevHistory: dummies })
    const hist = extractIsland(html, 'pf-history')
    assert.equal(hist.entries.length, 8, 'exactly 8 entries after the cap')
    assert.equal(hist.entries[0].docId, renderPlan(v2).docId, 'the real new entry survives at the front')
  })

  check('identical sources still carry a passed prevHistory (no new entry)', () => {
    const { html } = renderPlan(v2, { prevSource: v2, prevHistory: hist2.entries })
    assert.ok(!html.includes('id="pf-changes"'), 'no diff -> no pf-changes island')
    const hist = extractIsland(html, 'pf-history')
    assert.ok(hist, 'history island still present')
    assert.deepEqual(hist.entries, hist2.entries, 'entries pass through unchanged (nothing prepended)')
  })
})

// ---------------------------------------------------------------------------
// Replies island (agent replies to reviewer notes) + extractPrevVersion
// round-trip.
// ---------------------------------------------------------------------------
fixture('replies island & extractPrevVersion', (check) => {
  const v1 =
    '---\ntitle: T\n---\n\n' +
    'Alpha paragraph in version one.\n\n' +
    'Shared closing paragraph stays put.\n'
  const v2 =
    '---\ntitle: T\n---\n\n' +
    'Beta paragraph replaces the alpha one.\n\n' +
    'Shared closing paragraph stays put.\n'

  check('valid replies are baked into a pf-replies island (note kept)', () => {
    const replies = [
      { anchor: 'p:alpha-paragraph-in-version-one', reply: 'Done — reworded it.', note: 'the original note' },
      { anchor: 'p:shared-closing-paragraph-stays-put', reply: 'Left as is.' },
    ]
    const { html, warnings } = renderPlan(v1, { replies })
    const island = extractIsland(html, 'pf-replies')
    assert.ok(island, 'pf-replies island present and parseable')
    assert.equal(island.version, 1)
    assert.deepEqual(island.replies, replies, 'entries round-trip exactly, note included')
    assert.equal(warnings.length, 0, 'no warnings for valid replies')
  })

  check('an entry missing its reply is skipped WITH a warning', () => {
    const { html, warnings } = renderPlan(v1, {
      replies: [{ anchor: 'p:alpha-paragraph-in-version-one', reply: 'kept' }, { anchor: 'p:orphan' }],
    })
    const island = extractIsland(html, 'pf-replies')
    assert.equal(island.replies.length, 1, 'only the valid entry survives')
    assert.equal(island.replies[0].reply, 'kept')
    assert.ok(
      warnings.some((w) => /replies/.test(w) && /skipped/.test(w)),
      `a warning names the skipped entry (got: ${JSON.stringify(warnings)})`,
    )
  })

  check('"</" in a reply is emitted as <\\/ — the island cannot self-terminate', () => {
    const evil = 'watch out for </script> in here'
    const { html } = renderPlan(v1, {
      replies: [{ anchor: 'p:alpha-paragraph-in-version-one', reply: evil }],
    })
    const m = /id="pf-replies">([\s\S]*?)<\/script>/.exec(html)
    assert.ok(m, 'island found in the html')
    assert.ok(!m[1].includes('</'), 'no raw "</" inside the island JSON')
    // ...and the escaped form still parses back to the original string.
    assert.equal(extractIsland(html, 'pf-replies').replies[0].reply, evil)
  })

  check('no replies -> no island; invalid shape -> warning + no island', () => {
    const none = renderPlan(v1)
    assert.ok(!none.html.includes('id="pf-replies"'), 'no island when replies omitted')
    const empty = renderPlan(v1, { replies: [] })
    assert.ok(!empty.html.includes('id="pf-replies"'), 'no island for an empty array')
    const bad = renderPlan(v1, { replies: { nope: true } })
    assert.ok(!bad.html.includes('id="pf-replies"'), 'no island for an invalid top-level shape')
    assert.ok(
      bad.warnings.some((w) => /replies/.test(w)),
      `invalid shape pushes a warning (got: ${JSON.stringify(bad.warnings)})`,
    )
  })

  check('extractPrevVersion round-trips source, renderedAt and history', () => {
    const page2 = renderPlan(v2, { prevSource: v1, prevRenderedAt: '2026-07-10T12:00:00.000Z' })
    const prev = extractPrevVersion(page2.html)
    assert.ok(prev, 'extractPrevVersion returns a value for a rendered page')
    assert.equal(prev.source, v2, 'source is the exact v2 markdown')
    assert.equal(prev.renderedAt, extractIsland(page2.html, 'pf-anchor-map').renderedAt, "renderedAt matches the page's own anchor map")
    assert.deepEqual(prev.history, extractIsland(page2.html, 'pf-history').entries, 'history matches the pf-history entries')
  })

  check('extractPrevVersion defaults history to [] on a history-less page', () => {
    const page1 = renderPlan(v1)
    const prev = extractPrevVersion(page1.html)
    assert.equal(prev.source, v1)
    assert.deepEqual(prev.history, [], 'no pf-history island -> empty array')
  })
})

// ---------------------------------------------------------------------------
// Theme: mono by default, `theme: manual` restores the original look.
// ---------------------------------------------------------------------------
fixture('theme (inline)', (check) => {
  const diagram = '```diagram\nflowchart LR\n  A --> B\n```\n'
  const looks = (html) => [...html.matchAll(/<pre class="mermaid" data-look="(\w+)"/g)].map((m) => m[1])
  const pfTheme = (html) => /<html[^>]*data-pf-theme="(\w+)"/.exec(html)?.[1]

  check('default is mono with clean diagrams and no Virgil font', () => {
    const r = renderPlan('# T\n\n' + diagram)
    assert.equal(pfTheme(r.html), 'mono')
    assert.deepEqual(looks(r.html), ['clean'])
    assert.doesNotMatch(r.html, /font-family:"Virgil"/)
  })

  check('frontmatter theme: manual restores hand-drawn diagrams and Virgil', () => {
    const r = renderPlan('---\ntitle: T\ntheme: manual\n---\n' + diagram)
    assert.equal(pfTheme(r.html), 'manual')
    assert.deepEqual(looks(r.html), ['handDrawn'])
    assert.match(r.html, /font-family:"Virgil"/)
  })

  check('the theme option overrides frontmatter', () => {
    const r = renderPlan('---\ntitle: T\ntheme: manual\n---\n' + diagram, { theme: 'mono' })
    assert.equal(pfTheme(r.html), 'mono')
    assert.deepEqual(looks(r.html), ['clean'])
  })

  check('an explicit look wins over the theme default', () => {
    const src = '```diagram look=handDrawn\nflowchart LR\n  A --> B\n```\n```diagram look=clean\nflowchart LR\n  C --> D\n```\n'
    assert.deepEqual(looks(renderPlan(src).html), ['handDrawn', 'clean'])
    assert.deepEqual(looks(renderPlan(src, { theme: 'manual' }).html), ['handDrawn', 'clean'])
  })

  check('an unknown theme warns and falls back to mono', () => {
    const r = renderPlan('---\ntitle: T\ntheme: neon\n---\nbody\n')
    assert.equal(pfTheme(r.html), 'mono')
    assert.ok(r.warnings.some((w) => /unknown theme "neon"/.test(w)), r.warnings.join('; '))
  })
})

fixture('stepper.md', (check) => {
  const sourcePath = join(FIXTURES, 'stepper.md')
  const r = renderPlan(read('stepper.md'), { sourcePath })
  const html = r.html
  const block = (type) => new RegExp(`<figure data-block="${type}"[\\s\\S]*?</figure>`).exec(html)?.[0] ?? ''
  const fig = block('figure')
  const stp = block('stepper')
  const steps = [...stp.matchAll(/<(li|aside) class="stepper-step[^"]*"[^>]*>/g)].map((m) => m[0])
  const attr = (tag, name) => {
    const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
    return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null
  }

  check('a clean figure and stepper render with no warnings', () => {
    assert.deepEqual(r.warnings, [])
  })

  check('figure inlines the SVG with title, description and size bounds from the viewBox', () => {
    assert.match(fig, /<div class="figure-stage"><svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 720 200" role="img" aria-labelledby="fig1-title" aria-describedby="fig1-desc">/)
    assert.match(fig, /^<figure data-block="figure"[^>]* style="--fig-w:720px;--fig-ar:3.6">/)
    assert.match(stp, /^<figure data-block="stepper"[^>]* style="--fig-w:\d+px;--fig-ar:[\d.]+">/)
    assert.match(fig, /<title id="fig1-title">Request path<\/title><desc id="fig1-desc">A browser request crosses the gateway/)
    assert.doesNotMatch(fig, /width="720"|<\?xml/, 'root width/height and the XML prolog are dropped')
    assert.equal((fig.match(/data-part="/g) || []).length, 7)
  })

  check('stepper reuses the figure under its own id prefix', () => {
    assert.match(stp, /<div class="stepper-stage"><svg [^>]*aria-labelledby="stp1-title"/)
    assert.match(stp, /<desc id="stp1-desc">1\. The user fills the form 2\. The browser sends the request 3\. The service writes the row<\/desc>/)
  })

  check('steps carry their parts, needs flag and carried-forward counter values', () => {
    assert.equal(steps.length, 4)
    assert.deepEqual(steps.map((s) => attr(s, 'data-parts')), [
      'browser', 'browser e-gateway gateway', 'e-service service e-db db', 'browser',
    ])
    assert.deepEqual(steps.slice(0, 3).map((s) => JSON.parse(attr(s, 'data-counters'))), [
      { sent: '0', stored: '0' }, { sent: '1', stored: '0' }, { sent: '1', stored: '1' },
    ])
    assert.deepEqual(steps.slice(0, 3).map((s) => JSON.parse(attr(s, 'data-off-counters'))), [
      { sent: '0', stored: '0' }, { sent: '0', stored: '0' }, { sent: '0', stored: '0' },
    ], 'with the network off nothing is sent or stored')
    assert.equal(attr(steps[3], 'data-counters'), null, 'a held step shows the values of the step it stands in for')
    assert.deepEqual(steps.map((s) => /\sdata-needs[\s>]/.test(s)), [false, true, true, false])
    assert.match(steps[3], /^<aside class="stepper-step stepper-held"/)
  })

  check('each step has a where line, title, narration, key idea and what changed', () => {
    assert.match(stp, /<p class="stepper-where">Step 2 of 3<\/p><h3>The browser sends the request<\/h3><p>The browser serialises the form/)
    assert.match(stp, /<div class="stepper-key"><p class="stepper-label">Key idea<\/p><p>The database write is the commit point\.<\/p><\/div>/)
    assert.match(stp, /<ul><li>One row exists\.<\/li><li>The request is answered\.<\/li><\/ul>/)
    assert.match(stp, /<p class="stepper-where">Network off<\/p><h3>The network is down<\/h3>/)
  })

  check('controls: one bar button per sequence step, a switch, counters starting at step 1', () => {
    assert.equal((stp.match(/<button type="button" data-step="/g) || []).length, 3)
    assert.match(stp, /class="stepper-switch" role="switch" aria-checked="true">[^]*?Network <span class="stepper-switch-state">on<\/span>/)
    assert.match(stp, /<p class="stepper-counter" data-counter="sent"><b>0<\/b> Requests sent<\/p>/)
  })

  check('the stepper and each step are feedback anchors', () => {
    const map = extractIsland(html, 'pf-anchor-map')
    const keys = Object.keys(map.anchors)
    assert.equal(map.anchors['stepper:one-request-end-to-end:the-network-is-down'].kind, 'stepper-step')
    assert.ok(keys.includes('stepper:one-request-end-to-end'), keys.join(', '))
    assert.ok(keys.includes('stepper:one-request-end-to-end:the-network-is-down'), keys.join(', '))
    assert.ok(keys.includes('figure:request-path'), keys.join(', '))
  })
})

fixture('embed.md', (check) => {
  const sourcePath = join(FIXTURES, 'embed.md')
  const r = renderPlan(read('embed.md'), { sourcePath })
  const fig = /<figure data-block="embed"[\s\S]*?<\/figure>/.exec(r.html)?.[0] ?? ''
  const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  const srcdoc = unesc(/data-srcdoc="([^"]*)"/.exec(fig)?.[1] ?? '')

  check('renders with no warnings', () => assert.deepEqual(r.warnings, []))

  check('the page forbids frames from loading URLs (an embed cannot navigate)', () => {
    assert.match(r.html, /<meta http-equiv="Content-Security-Policy" content="frame-src 'none'" \/>/)
  })

  check('the poster is inlined and alt-texted by the body; Run starts hidden for no-script', () => {
    assert.match(fig, /<img class="embed-poster" src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+" alt="Drag the \*\*length\*\* slider: a longer pendulum swings more slowly\.">/)
    assert.match(fig, /<button type="button" class="embed-run" aria-label="Run Pendulum" hidden>Run<\/button>/)
    assert.match(fig, /--embed-h:300px/)
  })

  check('the file rides escaped in data-srcdoc, behind a no-network CSP', () => {
    assert.ok(srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${EMBED_CSP}"><!--pf-tokens--><!doctype html>`))
    assert.ok(srcdoc.includes(read('embeds/pendulum.html')))
    assert.match(EMBED_CSP, /default-src 'none'/)
    assert.doesNotMatch(EMBED_CSP, /connect-src|https?:|\*/)
    assert.doesNotMatch(fig.replace(/data-srcdoc="[^"]*"/, ''), /<script|<canvas/, 'nothing from the file is live in the page')
  })

  check('the body renders as markdown under the stage, and is a pf anchor', () => {
    assert.match(fig, /<div class="embed-note"><p>Drag the <strong>length<\/strong> slider/)
    assert.match(fig, /data-pf-anchor="embed:pendulum"/)
  })
})

fixture('composite.md', (check) => {
  const r = renderPlan(read('composite.md'), { sourcePath: join(FIXTURES, 'composite.md') })
  const first = /<figure data-block="stepper"[\s\S]*?<\/figure>/.exec(r.html)[0]
  const steps = [...first.matchAll(/<li class="stepper-step"[\s\S]*?<\/li>(?=<li class="stepper-step"|<\/ol>)/g)].map((m) => m[0])
  const paths = (st) => [...st.matchAll(/<code>(.*?)<\/code><\/a>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''))

  check('inside this git worktree, every cited path is checked and reported missing, nothing else warns', () => {
    assert.equal(r.warnings.length, 7, r.warnings.join(' | '))
    assert.ok(r.warnings.every((w) => /code path "src\/[^"]+" is not in the repo/.test(w)), r.warnings.join(' | '))
  })

  check('the workers part is a three-layer card the size of its neighbours, stacked toward the bottom right', () => {
    const workers = /<g data-part="workers">[\s\S]*?<\/g>/.exec(first)[0]
    const rects = [...workers.matchAll(/<rect class="box" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)].map((m) => m.slice(1).map(Number))
    assert.deepEqual(rects, [[352, 160, 112, 56], [348, 156, 112, 56], [344, 152, 112, 56]], 'back copy first, each 4 down and right of the next')
    assert.match(first, /<g data-part="queue">\s*<rect class="box" x="\d+" y="152" width="112" height="56"/)
  })

  check('each step lists the code of its own parts, linked under repo:', () => {
    assert.deepEqual(steps.map(paths), [['src/api/jobs.ts', 'src/queue/'], ['src/workers/'], ['src/store/']])
    assert.match(steps[0], /<a href="https:\/\/git\.example\.com\/shop\/blob\/main\/src\/api\/jobs\.ts" target="_blank" rel="noopener">/)
  })

  check('the workers card links to the exploded figure, which is on the page', () => {
    const workers = /<g data-part="workers">[\s\S]*?<\/g>/.exec(r.html)[0]
    assert.match(workers, /<a href="#stepper:inside-the-workers"><text[^>]*>See inside ↓<\/text><\/a>/)
    assert.match(r.html, /<figure data-block="stepper" data-pf-anchor="stepper:inside-the-workers" id="stepper:inside-the-workers"/)
  })

  check('inside the workers is an axonometric plan: the pools side by side, a gate on the email lane, each building a rise part, marks painted on roofs', () => {
    const inside = /<figure data-block="stepper" data-pf-anchor="stepper:inside-the-workers"[\s\S]*?<\/figure>/.exec(r.html)[0]
    assert.deepEqual([...inside.matchAll(/<g data-part="([^"]+)" data-rise="">/g)].map((m) => m[1]), ['queue', 'w-images', 'limit', 'w-email', 'w-search', 'store'])
    const marks = [...inside.matchAll(/<use href="#([^"]+)" class="mark"[^>]* transform="matrix\(1 0\.5 -1 0\.5 /g)].map((m) => m[1].replace(/^.*m-/, ''))
    assert.deepEqual(marks, ['redis', 'elasticsearch', 'postgresql'], 'each mark is skewed onto a roof')
    assert.deepEqual([...inside.matchAll(/<g data-part="(e-[^"]+)">/g)].map((m) => m[1]), ['e-images', 'e-email', 'e-search', 'e-store'])
    assert.equal((/<g data-part="e-store">[\s\S]*?<\/g>/.exec(inside)[0].match(/data-flow/g) || []).length, 3, 'three lanes merge on the store')
    const stack = /<figure data-block="stepper" data-pf-anchor="stepper:four-layers"[\s\S]*?<\/figure>/.exec(r.html)[0]
    assert.deepEqual([...stack.matchAll(/<g data-part="([^"]+)" data-lift="">/g)].map((m) => m[1]), ['storage', 'services', 'api', 'interface'], 'a layer stack keeps data-lift')
  })
})

fixture('<figure + stepper lint>', (check) => {
  const sourcePath = join(FIXTURES, 'x.md')
  const one = (md) => renderPlan(md, { sourcePath })
  const has = (r, re) => assert.ok(r.warnings.some((w) => re.test(w)), `no warning ${re} in: ${r.warnings.join(' | ')}`)

  check('forbidden SVG content is removed and reported', () => {
    const r = one('```figure src=figures/bad.svg title=Bad\nA bad figure.\n```\n')
    const fig = /<figure data-block="figure"[\s\S]*?<\/figure>/.exec(r.html)[0]
    for (const re of [/<script> removed/, /event handler attributes removed/, /<style> removed/, /href "https:\/\/example.com\/x.png" removed/]) has(r, re)
    assert.doesNotMatch(fig, /<script|onclick|<style|example\.com/)
  })

  check('non-token colours, duplicate parts, missing viewBox and extra accents are reported', () => {
    const r = one('```figure src=figures/bad.svg\nA bad figure.\n```\n')
    has(r, /fill="#ff0000" is not a token colour/)
    has(r, /stroke="rgb\(0,0,0\)" is not a token colour/)
    has(r, /data-part "a" is used more than once/)
    has(r, /no viewBox/)
    has(r, /3 data-accent elements \(at most 2\)/)
  })

  check('token colours pass the lint', () => {
    const r = one('```figure src=figures/request-path.svg\nok\n```\n')
    assert.deepEqual(r.warnings, [])
  })

  check('every house figure renders clean, and a stepper can walk all its parts', () => {
    const dir = join(__dirname, '..', '..', 'figures')
    const files = readdirSync(dir).filter((f) => f.endsWith('.svg'))
    assert.deepEqual(files.sort(), ['architecture.svg', 'click-path.svg', 'erd.svg', 'exploded.svg', 'layer-stack.svg', 'plan.svg', 'swimlane.svg'])
    // click-path.svg needs a switch; the worked-switch test walks it
    for (const f of files.filter((f) => f !== 'click-path.svg')) {
      const svg = readFileSync(join(dir, f), 'utf8')
      const parts = [...svg.matchAll(/data-part="([^"]+)"/g)].map((m) => m[1])
      assert.ok(parts.length >= 4, `${f}: ${parts.length} parts`)
      const md = `\`\`\`figure src=${f}\nx\n\`\`\`\n\`\`\`stepper figure=${f}\n# All\nparts: ${parts.join(' ')}\nkey: k\n\`\`\`\n`
      const r = renderPlan(md, { sourcePath: join(dir, 'p.md') })
      assert.deepEqual(r.warnings, [], f)
      for (const p of parts) assert.match(r.html, new RegExp(`data-part="${p}"`), `${f}: ${p}`)
    }
  })

  check('stepper code: captions per step, linked under repo:, checked against the git root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-code-'))
    for (const d of ['.git', 'docs', 'src/api', 'src/queue']) mkdirSync(join(dir, d), { recursive: true })
    writeFileSync(join(dir, 'src/api/jobs.ts'), '')
    writeFileSync(join(dir, 'src/api/a b&c.ts'), '')
    writeFileSync(join(dir, 'f.svg'), '<svg viewBox="0 0 100 40"><g data-part="a"><rect class="box" x="0" y="0" width="20" height="20"/></g><g data-part="b"><rect class="box" x="40" y="0" width="20" height="20"/></g><g data-part="c"><rect class="box" x="80" y="0" width="20" height="20"/></g></svg>')
    writeFileSync(join(dir, 'docs', 'f.svg'), readFileSync(join(dir, 'f.svg'), 'utf8'))
    const md = (fm, code) => `---\ntitle: T\n${fm}---\n\n\`\`\`stepper figure=f.svg\n${code}\n# One\nparts: a\nkey: k\n\n# Two\nparts: b c\nkey: k\n\`\`\`\n`
    const steps = (r) => [...r.html.matchAll(/<li class="stepper-step"[\s\S]*?<\/li>(?=<li class="stepper-step"|<\/ol>)/g)].map((m) => m[0])
    const code = 'code: a src/api/jobs.ts\ncode: a src/api/a b&c.ts\ncode: b src/queue/'

    const r = renderPlan(md('repo: https://git.example.com/shop/blob/main/\n', code), { sourcePath: join(dir, 'docs', 'p.md') })
    assert.deepEqual(r.warnings, [])
    const [one, two] = steps(r)
    assert.match(one, /<div class="stepper-code" data-kind="code"><p class="stepper-label">In the code<\/p><ul><li><a href="https:\/\/git\.example\.com\/shop\/blob\/main\/src\/api\/jobs\.ts" target="_blank" rel="noopener"><code><span class="stepper-dir">src\/api\/<\/span>jobs\.ts<\/code><\/a><\/li><li><a href="https:\/\/git\.example\.com\/shop\/blob\/main\/src\/api\/a%20b%26c\.ts" target="_blank" rel="noopener"><code><span class="stepper-dir">src\/api\/<\/span>a b&amp;c\.ts<\/code><\/a><\/li><\/ul><\/div>/)
    assert.doesNotMatch(one, /src\/queue/)
    assert.match(two, /<a href="https:\/\/git\.example\.com\/shop\/blob\/main\/src\/queue\/" target="_blank" rel="noopener"><code><span class="stepper-dir">src\/<\/span>queue\/<\/code><\/a>/)
    assert.doesNotMatch(two, /jobs\.ts/)

    const plain = renderPlan(md('', code), { sourcePath: join(dir, 'p.md') })
    assert.deepEqual(plain.warnings, [])
    assert.match(steps(plain)[0], /<li><code><span class="stepper-dir">src\/api\/<\/span>jobs\.ts<\/code><\/li>/)
    assert.doesNotMatch(plain.html, /<a href="[^"#]*src\/api/)

    const bad = renderPlan(md('repo: javascript:alert(1)\n', code + '\ncode: a src/api/gone.ts\ncode: zz src/x.ts\ncode: c ../outside.ts\ncode: c /etc/passwd\ncode: c'), { sourcePath: join(dir, 'p.md') })
    has(bad, /repo: must be an http\(s\) URL/)
    has(bad, /code path "src\/api\/gone\.ts" is not in the repo/)
    has(bad, /code: unknown part "zz"/)
    has(bad, /code path "\.\.\/outside\.ts" must be relative to the repo root/)
    has(bad, /code path "\/etc\/passwd" must be relative to the repo root/)
    has(bad, /"code: c" needs a part and a path/)
    assert.doesNotMatch(bad.html, /javascript:|outside\.ts<|passwd/)

    const loose = mkdtempSync(join(tmpdir(), 'pf-code-'))
    writeFileSync(join(loose, 'f.svg'), readFileSync(join(dir, 'f.svg'), 'utf8'))
    assert.deepEqual(renderPlan(md('', 'code: a src/not-here.ts'), { sourcePath: join(loose, 'p.md') }).warnings, [], 'outside a git repo, paths are not checked')
  })

  check('stepper code: named repos show their word and link base; only the home repo is checked on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-code-'))
    for (const d of ['.git', 'src/api']) mkdirSync(join(dir, d), { recursive: true })
    writeFileSync(join(dir, 'src/api/jobs.ts'), '')
    writeFileSync(join(dir, 'f.svg'), '<svg viewBox="0 0 100 40"><g data-part="a"><rect class="box" x="0" y="0" width="20" height="20"/></g><g data-part="b"><rect class="box" x="40" y="0" width="20" height="20"/></g></svg>')
    const page = (fm, code) => `---\ntitle: T\n${fm}---\n\n\`\`\`stepper figure=f.svg\n${code}\n# One\nparts: a\nkey: k\n\n# Two\nparts: b\nkey: k\n\`\`\`\n`
    const steps = (r) => [...r.html.matchAll(/<li class="stepper-step"[\s\S]*?<\/li>(?=<li class="stepper-step"|<\/ol>)/g)].map((m) => m[0])
    const fm = 'repo: App https://git.example.com/app/blob/main\nrepo: Libs https://git.example.com/libs/blob/main/\n'

    const r = renderPlan(page(fm, 'code: a src/api/jobs.ts\ncode: a App src/api/jobs.ts\ncode: b Libs ledger/only-there.ts'), { sourcePath: join(dir, 'p.md') })
    assert.deepEqual(r.warnings, [], 'a Libs path is not checked against this checkout')
    const [one, two] = steps(r)
    assert.match(one, /<ul><li><span class="stepper-repo" title="https:\/\/git\.example\.com\/app\/blob\/main">App<\/span> <a href="https:\/\/git\.example\.com\/app\/blob\/main\/src\/api\/jobs\.ts" target="_blank" rel="noopener"><code><span class="stepper-dir">src\/api\/<\/span>jobs\.ts<\/code><\/a><\/li><\/ul>/, 'the bare path and the App path are one item')
    assert.match(two, /<li><span class="stepper-repo" title="https:\/\/git\.example\.com\/libs\/blob\/main">Libs<\/span> <a href="https:\/\/git\.example\.com\/libs\/blob\/main\/ledger\/only-there\.ts" target="_blank" rel="noopener"><code><span class="stepper-dir">ledger\/<\/span>only-there\.ts<\/code><\/a><\/li>/)

    const bad = renderPlan(page(fm, 'code: a App src/gone.ts\ncode: b Libs ../x.ts\ncode: b Lib ledger/x.ts'), { sourcePath: join(dir, 'p.md') })
    has(bad, /code path "src\/gone\.ts" is not in the repo/)
    has(bad, /code path "\.\.\/x\.ts" must be relative to the repo root/)
    has(bad, /code path "Lib ledger\/x\.ts" is not in the repo/)
    has(renderPlan(page('repo: https://a.example.com\nrepo: Libs https://b.example.com\n', 'code: a src/api/jobs.ts'), { sourcePath: join(dir, 'p.md') }), /with more than one repo, give each a short name/)
    has(renderPlan(page('repo: App git@example.com:app\n', 'code: a src/api/jobs.ts'), { sourcePath: join(dir, 'p.md') }), /repo: must be an http\(s\) URL/)
    has(renderPlan(page(fm + 'repo: Libs https://other.example.com\n', 'code: a src/api/jobs.ts'), { sourcePath: join(dir, 'p.md') }), /repo: the name "Libs" is used more than once/)

    writeFileSync(join(dir, 'src/api/my file.ts'), '')
    const spaced = renderPlan(page(fm, 'code: a src/api/my file.ts'), { sourcePath: join(dir, 'p.md') })
    assert.deepEqual(spaced.warnings, [], 'a home path with a space is still a path when its first word is not a repo name')
    assert.match(spaced.html, /<span class="stepper-repo"[^>]*>App<\/span> <a href="https:\/\/git\.example\.com\/app\/blob\/main\/src\/api\/my%20file\.ts" target="_blank" rel="noopener">/)

    const docs = renderPlan(page(fm, 'code: a src/api/jobs.ts\ncode: b src/api/jobs.ts\ndocs: a Libs guide/jobs.md | Retries, Dead letters\ndocs: b README.md\ndocs: b ../x.md\ndocs: zz y.md\ndocs: b'), { sourcePath: join(dir, 'p.md') })
    has(docs, /docs path "README\.md" is not in the repo/)
    has(docs, /docs path "\.\.\/x\.md" must be relative to the repo root/)
    has(docs, /docs: unknown part "zz"/)
    has(docs, /"docs: b" needs a part and a path/)
    const [d1, d2] = steps(docs)
    assert.match(d1, /<div class="stepper-code" data-kind="code"><p class="stepper-label">In the code<\/p><ul><li>[^]*?jobs\.ts[^]*?<\/ul><\/div><div class="stepper-code" data-kind="docs"><p class="stepper-label">In the docs<\/p><ul><li><span class="stepper-repo"[^>]*>Libs<\/span> <a href="https:\/\/git\.example\.com\/libs\/blob\/main\/guide\/jobs\.md" target="_blank" rel="noopener"><code><span class="stepper-dir">guide\/<\/span>jobs\.md<\/code><\/a> <span class="stepper-note">Retries, Dead letters<\/span><\/li><\/ul><\/div>/)
    assert.match(d2, /data-kind="docs"[^]*?<code>README\.md<\/code><\/a><\/li><\/ul>/, 'a doc with no note and no folder')
    assert.doesNotMatch(d2, /guide\/jobs\.md|stepper-note/)

    const odd = renderPlan(page('repo: <b>"x https://git.example.com/a"onmouseover="y\n', 'code: a <b>"x src/api/jobs.ts'), { sourcePath: join(dir, 'p.md') })
    assert.doesNotMatch(odd.html, /<b>"x|"onmouseover=/, 'repo names and URLs are escaped')
    assert.match(odd.html, /<span class="stepper-repo" title="https:\/\/git\.example\.com\/a&quot;onmouseover=&quot;y">&lt;b&gt;&quot;x<\/span>/)
  })

  check('embed lint: URL src, missing poster, remote refs, size and count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-embed-'))
    writeFileSync(join(dir, 'e.html'), '<script src="https://cdn.example.com/x.js"></script>')
    writeFileSync(join(dir, 'big.html'), 'x'.repeat(2 * 1024 * 1024 + 1))
    writeFileSync(join(dir, 'p.png'), 'png')
    const at = (md) => renderPlan(md, { sourcePath: join(dir, 'p.md') })
    const e = (a, body = 'x') => '```embed ' + a + '\n' + body + '\n```\n'
    has(at(e('src=https://example.com/a.html poster=p.png')), /src must be a local file, not a URL/)
    const noPoster = at(e('src=e.html'))
    has(noPoster, /missing poster; only the body is shown/)
    assert.doesNotMatch(/<figure data-block="embed"[\s\S]*?<\/figure>/.exec(noPoster.html)[0], /embed-stage|data-srcdoc/)
    has(at(e('src=e.html poster=p.png')), /remote reference "https:\/\/cdn.example.com" will be blocked/)
    const big = at(e('src=big.html poster=p.png'))
    has(big, /file is over 2 MB/)
    assert.doesNotMatch(big.html, /data-srcdoc=/)
    has(at(e('src=e.html poster=p.gif')), /poster must be/)
    has(at(e('src=e.html poster=p.png', '')), /body \(what to try and what it shows\) is empty/)
    has(at(e('src=e.html poster=p.png').repeat(3)), /more than 2 embeds/)
  })

  check('a link in a figure must land on this page: an in-figure id, a heading or a block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-link-'))
    const svg = (href) => `<svg viewBox="0 0 100 40"><defs><path id="p" d="M0 0H10"/></defs><g data-part="a"><a href="${href}"><text x="0" y="20">go</text></a></g></svg>`
    writeFileSync(join(dir, 'own.svg'), svg('#p'))
    writeFileSync(join(dir, 'head.svg'), svg('#h:pools'))
    writeFileSync(join(dir, 'none.svg'), svg('#h:nowhere'))
    const at = (f) => renderPlan(`# T\n\n## Pools\n\n\`\`\`figure src=${f}\nx\n\`\`\`\n`, { sourcePath: join(dir, 'p.md') })
    assert.deepEqual(at('own.svg').warnings, [])
    assert.deepEqual(at('head.svg').warnings, [])
    assert.match(at('head.svg').html, /<a href="#h:pools">/)
    has(at('none.svg'), /figure none\.svg: link "#h:nowhere" has no target on this page/)
    const twice = renderPlan(`# T\n\n<span data-id="h:nowhere"></span>\n\n\`\`\`figure src=none.svg\nx\n\`\`\`\n\n\`\`\`figure src=none.svg\ny\n\`\`\`\n`, { sourcePath: join(dir, 'p.md') })
    assert.deepEqual(twice.warnings, ['figure none.svg: link "#h:nowhere" has no target on this page'], 'one warning per figure file, and data-id is not an id')
    assert.match(at('head.svg').html, /<svg[^>]* role="group"/, 'a figure with a link is not role=img, so the link is announced')
    assert.match(at('own.svg').html, /<svg[^>]* role="img"/)
  })

  check('state: is a named figure state; set: changes it, carried forward; data-show groups follow it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-state-'))
    writeFileSync(join(dir, 's.svg'), '<svg viewBox="0 0 100 40"><g data-part="a"><rect class="box" x="0" y="0" width="10" height="10"/></g><g data-show="door=open"><text x="0" y="30">open</text></g><g data-show="door=shut"><text x="0" y="30">shut</text></g><g data-show="light=on"><text x="40" y="30">on</text></g></svg>')
    const at = (head, steps) => renderPlan(`# T\n\n\`\`\`stepper figure=s.svg\n${head}\n${steps}\`\`\`\n`, { sourcePath: join(dir, 'p.md') })
    const r = at('state: door open shut\nstate: light off on\ncounter: n | Things', '# One\nparts: a\nkey: k\n\n# Two\nparts: a\nset: door=shut, n=1\nkey: k\n\n# Three\nparts: a\nset: light=on\nkey: k\n')
    assert.deepEqual(r.warnings, [])
    const vals = [...r.html.matchAll(/data-counters="([^"]*)"/g)].map((m) => JSON.parse(m[1].replace(/&quot;/g, '"')))
    assert.deepEqual(vals, [{ n: '0', door: 'open', light: 'off' }, { n: '1', door: 'shut', light: 'off' }, { n: '1', door: 'shut', light: 'on' }])
    assert.match(r.html, /<g data-show="door=open" data-init data-on>/, 'the first value is the initial state, shown without script and in print')
    assert.match(r.html, /<g data-show="door=shut">/)
    assert.match(r.html, /<g data-show="light=on">/)
    assert.equal((r.html.match(/stepper-counter"/g) || []).length, 1, 'a state is not drawn as a counter')

    const spaced = at('state: door open shut\nstate: light off on\ncounter: n | Things\ncounter: t | Time', '# One\nparts: a\nset: door=shut n=2 t=3 ms\nkey: k\n')
    assert.deepEqual(spaced.warnings, [])
    assert.deepEqual(JSON.parse(/data-counters="([^"]*)"/.exec(spaced.html)[1].replace(/&quot;/g, '"')), { n: '2', t: '3 ms', door: 'shut', light: 'off' }, 'set: splits on spaces before a name=, as parts: does, and keeps spaces inside a value')

    const bad = at('state: door open shut\nstate: lone x\ncounter: door | Doors', '# One\nparts: a\nset: door=ajar, nope=1\nkey: k\n')
    has(bad, /state: lone x" needs a name and at least two values/)
    has(bad, /"door" is both a counter and a state/)
    has(bad, /step "One" sets door to "ajar", which is not one of: open shut/)
    has(bad, /step "One" sets unknown counter or state "nope"/)
    assert.equal(JSON.parse(/data-counters="([^"]*)"/.exec(bad.html)[1].replace(/&quot;/g, '"')).door, 'open', 'a value the state does not have is dropped, not carried')
    has(bad, /data-show "light=on" names no state/)
    writeFileSync(join(dir, 'v.svg'), '<svg viewBox="0 0 100 40"><g data-part="a"/><g data-show="door=ajar"/><g data-show="door"/></svg>')
    const v = renderPlan('# T\n\n```stepper figure=v.svg\nstate: door open shut\n# One\nparts: a\nkey: k\n```\n', { sourcePath: join(dir, 'p.md') })
    has(v, /data-show "door=ajar": door is one of: open shut/)
    has(v, /data-show "door" needs name=value/)
    const plain = renderPlan('# T\n\n```figure src=s.svg\nx\n```\n', { sourcePath: join(dir, 'p.md') })
    has(plain, /figure s\.svg: data-show works only in a stepper with state:/)
  })

  check('a missing file warns and keeps the description as text', () => {
    const r = one('```figure src=figures/nope.svg\nThe description survives.\n```\n')
    has(r, /figure figures\/nope.svg: cannot read file/)
    assert.match(r.html, /<p class="figure-fallback">The description survives\.<\/p>/)
  })

  check('an empty body warns', () => {
    has(one('```figure src=figures/request-path.svg\n```\n'), /body \(what the figure shows\) is empty/)
  })

  check('ids and references are prefixed per figure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-fig-'))
    writeFileSync(join(dir, 'a.svg'), '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>')
    const md = '```figure src=a.svg\nx\n```\n```figure src=a.svg\ny\n```\n'
    const r = renderPlan(md, { sourcePath: join(dir, 'p.md') })
    assert.match(r.html, /id="fig1-g"\/><\/defs><rect fill="url\(#fig1-g\)"\/><use href="#fig1-g"\/>/)
    assert.match(r.html, /id="fig2-g"\/><\/defs><rect fill="url\(#fig2-g\)"\/><use href="#fig2-g"\/>/)
    assert.deepEqual(r.warnings, [])
  })

  const stepper = (head, steps) => one('```stepper figure=figures/request-path.svg\n' + head + '\n' + steps + '\n```\n')

  check('unknown parts, unknown counters and missing key ideas are reported', () => {
    const r = stepper('counter: a | A', '# One\nparts: browser nope\nset: a=1, b=2\n\nText.')
    has(r, /step "One" names part "nope", which the figure does not have/)
    has(r, /step "One" sets unknown counter or state "b"/)
    has(r, /step "One" has no key:/)
  })

  check('switch lints: no held step, held without switch, held without needs', () => {
    has(stepper('switch: Net', '# One\nkey: k\nneeds: switch'), /a switch with no held or off: step/)
    has(stepper('', '# One\nkey: k\n# Off\nheld\nkey: k'), /"needs: switch" or "held" without a switch/)
    has(stepper('switch: Net', '# One\nkey: k\n# Off\nheld\nkey: k'), /a held step but no step has "needs: switch"/)
  })

  check('budgets: more than three counters, one switch, ten steps', () => {
    const r = stepper('counter: a | A\ncounter: b | B\ncounter: c | C\ncounter: d | D\nswitch: X\nswitch: Y',
      Array.from({ length: 11 }, (_, i) => `# S${i}\nkey: k`).join('\n'))
    has(r, /4 counters \(at most 3\)/)
    has(r, /more than one switch/)
    has(r, /11 steps \(at most 10\)/)
    assert.equal((r.html.match(/data-counter="/g) || []).length, 3, 'extra counters are dropped')
  })

  check('switch off: the story leaves out needs: switch steps and swaps in off: steps; a held step keeps that story so far', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-off-'))
    writeFileSync(join(dir, 's.svg'), '<svg viewBox="0 0 100 40"><g data-part="a"/><g data-show="slip=lifted"/><g data-show="switch=off"/><g data-show="switch=on"/></svg>')
    const r = renderPlan('# T\n\n```stepper figure=s.svg\ncounter: n | Acknowledged\nstate: slip flat lifted\nstate: pen up down\nswitch: Net\n'
      + '# One\nparts: a\nset: n=1\nkey: k\n# Two\nneeds: switch\nset: n=5\nkey: k\n# End\nset: n=9, slip=lifted\nkey: k\n'
      + '# End offline\noff: End\nset: slip=lifted\nkey: k\n# After\nneeds: switch\nset: n=7\nkey: k\n# Held\nheld\nset: pen=down\nkey: k\n```\n', { sourcePath: join(dir, 'p.md') })
    assert.deepEqual(r.warnings, [])
    const read = (a) => [...r.html.matchAll(new RegExp(`<li class="stepper-step"[^>]* ${a}="([^"]*)"`, 'g'))].map((m) => Object.values(JSON.parse(m[1].replace(/&quot;/g, '"'))).join(' '))
    assert.deepEqual(read('data-counters'), ['1 flat up', '5 flat up', '9 lifted up', '7 lifted up'])
    assert.deepEqual(read('data-off-counters'), ['1 flat up', '1 flat down', '1 lifted up', '1 lifted down'],
      'Two and After are held (pen down); End offline starts from the off story (n=1) and After keeps its lifted slip')
    assert.match(r.html, /<aside class="stepper-step stepper-off"[^>]* data-counters="[^"]*lifted[^"]*"/, "the off step carries its own off-story values")
    assert.match(r.html, /<g data-show="switch=on" data-init data-on\/>/, 'the switch is a figure state, on at first')
    assert.match(r.html, /<g data-show="switch=off"\/>/)
    const none = renderPlan('# T\n\n```stepper figure=s.svg\nstate: slip flat lifted\n# One\nparts: a\nkey: k\n```\n', { sourcePath: join(dir, 'p.md') })
    has(none, /data-show "switch=off" names no state/)
    const own = renderPlan('# T\n\n```stepper figure=s.svg\nstate: slip flat lifted\nstate: switch on off\nswitch: Net\n# One\nparts: a\nkey: k\n# Off\nheld\nkey: k\n```\n', { sourcePath: join(dir, 'p.md') })
    assert.ok(!own.warnings.some((w) => /switch/.test(w) && /data-show/.test(w)), own.warnings.join(' | '))
  })

  check("figures.md's worked switch example renders clean and counts as it says", () => {
    const doc = readFileSync(join(__dirname, '..', '..', 'references', 'figures.md'), 'utf8')
    const block = /\n(```stepper figure=figures\/click-path\.svg[\s\S]*?\n```)\n/.exec(doc.slice(doc.indexOf('## A switch, worked through')))[1]
    const svg = /\n(<g data-show="switch=off">[\s\S]*?\n<\/g>)\n/.exec(doc)[1]
    const house = readFileSync(join(__dirname, '..', '..', 'figures', 'click-path.svg'), 'utf8')
    const lines = (s) => s.split('\n').map((l) => l.trim()).join('\n')
    assert.ok(lines(house).includes(lines(svg)), 'the snippet is the house figure\'s own bypass')
    const r = renderPlan('# T\n\n' + block + '\n', { sourcePath: join(__dirname, '..', '..', 'p.md') })
    assert.deepEqual(r.warnings, [])
    const named = new Set(block.split('\n').filter((l) => l.startsWith('parts:')).flatMap((l) => l.slice(6).trim().split(/\s+/)))
    assert.deepEqual([...house.matchAll(/data-part="([^"]+)"/g)].map((m) => m[1]).filter((p) => !named.has(p)), [], 'the example lights every part of click-path.svg')
    const last = (a) => JSON.parse([...r.html.matchAll(new RegExp(`<li class="stepper-step"[^>]* ${a}="([^"]*)"`, 'g'))].at(-1)[1].replace(/&quot;/g, '"'))
    assert.deepEqual(last('data-counters'), { cache: '1', db: '1' }, 'cache on: 1 and 1')
    assert.deepEqual(last('data-off-counters'), { cache: '0', db: '2' }, 'cache off: 0 and 2')
  })

  check('an off: step stands in for one step: from the values before it, out of the bar, linted', () => {
    const r = stepper('counter: a | A\nswitch: Net',
      '# One\nkey: k\nset: a=1\n# Two\nkey: k\nset: a=2\n# Three\nkey: k\nset: a=3\n# Two, offline\noff: Two\nparts: browser\nkey: k')
    assert.deepEqual(r.warnings, [])
    const vals = [...r.html.matchAll(/data-counters="([^"]*)"/g)].map((m) => JSON.parse(m[1].replace(/&quot;/g, '"')).a)
    assert.deepEqual(vals, ['1', '2', '3', '1'])
    assert.equal((r.html.match(/data-step="/g) || []).length, 3, 'not in the step bar')
    assert.match(r.html, /<aside class="stepper-step stepper-off" [^>]*data-parts="browser"[^>]* data-off-for="1"><p class="stepper-where">Net off<\/p><h3>Two, offline<\/h3>/)
    const shared = [...r.html.matchAll(/<p class="stepper-where">([^<]*)<\/p><p class="stepper-shared">Net off\. This step does not need it\.<\/p>/g)].map((m) => m[1])
    assert.deepEqual(shared, ['Step 1 of 3', 'Step 3 of 3'], 'only steps both stories share say so; not one with an off step, nor the off step')
    const needs = stepper('switch: Net', '# One\nkey: k\n# Two\nneeds: switch\nkey: k\n# Down\nheld\nkey: k')
    assert.deepEqual([...needs.html.matchAll(/<p class="stepper-where">([^<]*)<\/p><p class="stepper-shared">/g)].map((m) => m[1]), ['Step 1 of 2'], 'not a needs step, nor the held step')
    assert.doesNotMatch(stepper('', '# One\nkey: k').html, /<p class="stepper-shared">/, 'no switch, no line')
    const head = '# One\nkey: k\n'
    has(stepper('switch: Net', head + '# X\noff: Nope\nkey: k'), /"off: Nope" names no step/)
    has(stepper('switch: Net', head + '# X\noff: One\nkey: k\n# Y\noff: One\nkey: k'), /more than one off: step for "One"/)
    has(stepper('', head + '# X\noff: One\nkey: k'), /"off: One" without a switch in the header/)
    has(stepper('switch: Net', head + '# X\noff: One\nkey: k\nset: a=1'), /step "X" sets unknown counter or state "a"/)
  })

  check('a page that opens with a stepper, after at most one paragraph, marks its main with the figure size', () => {
    const stp = '```stepper figure=figures/request-path.svg\n# One\nkey: k\n```\n'
    const main = (md) => /<main [^>]*>/.exec(one(md).html)[0]
    assert.equal(main('# T\n\n<!-- a note -->\n\nLead **text**.\n\n' + stp), '<main id="plan-main" class="plan-main" data-leads="stepper" style="--fig-w:720px;--fig-ar:3.6">')
    assert.equal(main('# T\n\n' + stp), '<main id="plan-main" class="plan-main" data-leads="stepper" style="--fig-w:720px;--fig-ar:3.6">')
    assert.equal(main('# T\n\nOne.\n\nTwo.\n\n' + stp), '<main id="plan-main" class="plan-main">', 'two paragraphs first')
    assert.equal(main('# T\n\n## Part\n\n' + stp), '<main id="plan-main" class="plan-main">', 'a heading first')
    assert.equal(main('# T\n\nLead.\n\n```figure src=figures/request-path.svg title=F\nA figure.\n```\n\n' + stp), '<main id="plan-main" class="plan-main">', 'a plain figure first')
  })

  check('a missing stepper figure warns and still lays out the steps', () => {
    const r = one('```stepper figure=figures/nope.svg\n# One\nkey: k\n\nNarration survives.\n```\n')
    has(r, /cannot read file/)
    assert.match(r.html, /<h3>One<\/h3><p>Narration survives\.<\/p>/)
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
