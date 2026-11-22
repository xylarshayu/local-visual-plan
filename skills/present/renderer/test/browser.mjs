#!/usr/bin/env node
// Browser checks for the figure and stepper blocks: render the fixture, drive it
// in Chromium, assert the live DOM and sample screenshot pixels.
//
// Needs Playwright (not a repo dependency). Either have `playwright` or
// `playwright-core` resolvable, or point PLAYWRIGHT_PATH at its package dir:
//   PLAYWRIGHT_PATH=/path/to/node_modules/playwright-core node test/browser.mjs
// Set SHOTS_DIR to keep the screenshots.

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { renderPlan } from '../render.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function loadChromium() {
  for (const id of [process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core']) {
    if (!id) continue
    try { return require(id).chromium } catch { /* try the next */ }
  }
  console.error('browser.mjs: Playwright not found. Set PLAYWRIGHT_PATH to a playwright or playwright-core package dir.')
  process.exit(1)
}

const chromium = loadChromium()
const out = process.env.SHOTS_DIR || mkdtempSync(join(tmpdir(), 'pf-browser-'))
mkdirSync(out, { recursive: true })
const page = join(out, 'stepper.html')
const fixture = join(here, 'fixtures', 'stepper.md')
writeFileSync(page, renderPlan(readFileSync(fixture, 'utf8'), { sourcePath: fixture }).html)

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name) }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n          ' + String(e.message).split('\n').join('\n          ')) }
}

const state = (p) => p.evaluate(() => {
  const f = document.querySelector('figure[data-block=stepper]')
  return {
    live: f.classList.contains('is-live'),
    visible: [...f.querySelectorAll('.stepper-step')].filter((s) => s.offsetParent).map((s) => s.querySelector('h3').textContent),
    parts: Object.fromEntries([...f.querySelectorAll('[data-part]')].map((p) => [p.dataset.part, p.dataset.state || null])),
    counters: [...f.querySelectorAll('[data-counter] b')].map((b) => b.textContent),
    current: f.querySelector('.stepper-bar [aria-current=step]')?.textContent ?? null,
  }
})

// Read one screenshot pixel by decoding the PNG in the page itself (no image deps).
async function pixel(p, png, x, y) {
  return p.evaluate(async ({ b64, x, y }) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    return [...g.getImageData(x, y, 1, 1).data.slice(0, 3)]
  }, { b64: png.toString('base64'), x, y })
}

// Centre of a part's box, in the stepper screenshot's coordinates.
const partPoint = (p, part) => p.evaluate((part) => {
  const f = document.querySelector('figure[data-block=stepper]').getBoundingClientRect()
  const r = document.querySelector(`.stepper-stage [data-part="${part}"] .box`).getBoundingClientRect()
  return { x: Math.round(r.left - f.left + 12), y: Math.round(r.top - f.top + r.height / 2) }
}, part)

const token = (p, name) => p.evaluate((n) => {
  const d = document.createElement('div'); d.style.color = `var(${n})`; document.body.append(d)
  const c = getComputedStyle(d).color; d.remove(); return c.match(/\d+/g).slice(0, 3).map(Number)
}, name)
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

const browser = await chromium.launch()
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + page)
  await p.waitForSelector('figure[data-block=stepper]')
  return { p, ctx, errors }
}

console.log('\n# stepper in a browser')

await check('goes live on load: step 1 only, parts current/future, counters at 0, no errors', async () => {
  const { p, ctx, errors } = await open()
  const s = await state(p)
  assert.equal(s.live, true)
  assert.deepEqual(s.visible, ['The user fills the form'])
  assert.equal(s.parts.browser, 'current')
  assert.equal(s.parts.db, 'future')
  assert.deepEqual(s.counters, ['0', '0'])
  assert.equal(s.current, '1')
  assert.deepEqual(errors, [])
  await ctx.close()
})

await check('next and the step bar move the state; earlier parts become past', async () => {
  const { p, ctx } = await open()
  await p.click('.stepper-next')
  await p.click('.stepper-bar button[data-step="2"]')
  const s = await state(p)
  assert.deepEqual(s.visible, ['The service writes the row'])
  assert.deepEqual(s.parts, { browser: 'past', 'e-gateway': 'past', gateway: 'past', 'e-service': 'current', service: 'current', 'e-db': 'current', db: 'current' })
  assert.deepEqual(s.counters, ['1', '1'])
  assert.equal(await p.isDisabled('.stepper-next'), true)
  await ctx.close()
})

await check('switch off shows the held step in place of a step that needs it', async () => {
  const { p, ctx } = await open()
  await p.click('.stepper-next')
  await p.click('.stepper-switch')
  const s = await state(p)
  assert.deepEqual(s.visible, ['The network is down'])
  assert.equal(s.parts.browser, 'current')
  assert.equal(s.parts.gateway, 'future')
  assert.deepEqual(s.counters, ['0', '0'])
  assert.equal(await p.getAttribute('.stepper-switch', 'aria-checked'), 'false')
  assert.equal(await p.locator('.stepper-bar button.is-waiting').count(), 2)
  await p.click('.stepper-bar button[data-step="2"]')
  const h = await state(p)
  assert.deepEqual(h.visible, ['The network is down'])
  assert.equal(h.parts.gateway, 'future', 'held parts count only steps before the first needs: switch step')
  assert.deepEqual(h.counters, ['0', '0'])
  await p.click('.stepper-bar button[data-step="0"]')
  assert.deepEqual((await state(p)).visible, ['The user fills the form'], 'a step that does not need the switch still shows')
  await ctx.close()
})

await check('arrow keys step while focus is inside, and survive the end of the sequence', async () => {
  const { p, ctx } = await open()
  await p.focus('.stepper-next')
  for (const k of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft']) await p.keyboard.press(k)
  assert.equal((await state(p)).current, '2')
  await p.evaluate(() => document.activeElement.blur())
  await p.keyboard.press('ArrowRight')
  assert.equal((await state(p)).current, '2', 'keys outside the stepper do nothing')
  await ctx.close()
})

await check('screenshot: the current part is filled with accent-soft, a future part is faint', async () => {
  const { p, ctx } = await open()
  await p.click('.stepper-next')
  await p.waitForTimeout(400)
  const png = await p.locator('figure[data-block=stepper]').screenshot({ path: join(out, 'step2.png') })
  const soft = await token(p, '--accent-soft')
  const bg = await token(p, '--bg')
  const cur = await partPoint(p, 'gateway')
  const fut = await partPoint(p, 'service')
  assert.ok(near(await pixel(p, png, cur.x, cur.y), soft), 'current box is accent-soft')
  assert.ok(near(await pixel(p, png, fut.x, fut.y), bg), 'future box is the page background')
  const op = await p.evaluate(() => getComputedStyle(document.querySelector('.stepper-stage [data-part=service]')).opacity)
  assert.equal(op, '0.32')
  await ctx.close()
})

await check('phone: no page overflow; the stage scrolls to keep the current parts in view', async () => {
  const { p, ctx } = await open({ viewport: { width: 390, height: 844 } })
  await p.click('.stepper-next'); await p.click('.stepper-next')
  await p.locator('figure[data-block=stepper]').screenshot({ path: join(out, 'phone.png') })
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth), 390)
  const m = await p.evaluate(() => {
    const st = document.querySelector('.stepper-stage'), svg = st.querySelector('svg')
    const r = document.querySelector('.stepper-stage [data-part=service]').getBoundingClientRect(), s = st.getBoundingClientRect()
    return { scrollable: st.scrollWidth > st.clientWidth, left: st.scrollLeft, svgW: svg.getBoundingClientRect().width, inView: r.left >= s.left && r.right <= s.right }
  })
  assert.ok(m.scrollable && m.left > 0, JSON.stringify(m))
  assert.equal(m.svgW, 576, 'never narrower than 0.8 of the viewBox')
  assert.ok(m.inView, 'the current service box is visible')
  await ctx.close()
})

await check('reduced motion: part transitions are off (and on by default)', async () => {
  const dflt = await open()
  assert.notEqual(await dflt.p.evaluate(() => getComputedStyle(document.querySelector('.stepper-stage [data-part]')).transitionDuration), '0s')
  await dflt.ctx.close()
  const { p, ctx } = await open({ reducedMotion: 'reduce' })
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('.stepper-stage [data-part]')).transitionDuration), '0s')
  await ctx.close()
})

await check('no script: every step is laid out, controls hidden, parts all ink', async () => {
  const { p, ctx } = await open({ javaScriptEnabled: false })
  const s = await state(p)
  assert.equal(s.live, false)
  assert.equal(s.visible.length, 4)
  assert.ok(Object.values(s.parts).every((v) => v === null))
  assert.equal(await p.isVisible('.stepper-controls'), false)
  await p.locator('figure[data-block=stepper]').screenshot({ path: join(out, 'nojs.png') })
  await ctx.close()
})

await check('print: every step is laid out, controls hidden, the figure is ink', async () => {
  const { p, ctx } = await open()
  await p.click('.stepper-next')
  await p.emulateMedia({ media: 'print' })
  const s = await state(p)
  assert.equal(s.visible.length, 4)
  assert.equal(await p.isVisible('.stepper-controls'), false)
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('.stepper-stage [data-part=service]')).opacity), '1')
  await ctx.close()
})

await check('figure: text renders at its drawn size and the dark theme repaints the ink', async () => {
  const { p, ctx } = await open({ colorScheme: 'dark' })
  const m = await p.evaluate(() => {
    const svg = document.querySelector('.figure-stage svg')
    const t = svg.querySelector('text')
    return { w: svg.getBoundingClientRect().width, stroke: getComputedStyle(svg.querySelector('rect')).stroke, fg: getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() }
  })
  assert.equal(m.w, 720)
  const fg = await token(p, '--fg')
  assert.equal(m.stroke, `rgb(${fg.join(', ')})`)
  await p.locator('figure[data-block=figure]').screenshot({ path: join(out, 'figure-dark.png') })
  await ctx.close()
})

await browser.close()
console.log(`\nshots: ${out}\nTotal: ${passed} passed, ${failed} failed`)
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
process.exit(failed ? 1 : 0)
