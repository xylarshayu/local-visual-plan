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
import { spawnSync } from 'node:child_process'
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
async function open(opts = {}, file = page) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', (e) => errors.push(e.message))
  await p.goto('file://' + file)
  await p.waitForSelector('figure[data-block]')
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

await check('a stepper control focused under the review pill scrolls clear of it', async () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { p, ctx } = await open({ viewport })
    const r = await p.evaluate(async () => {
      document.documentElement.style.scrollBehavior = 'auto'
      const pill = document.querySelector('.pf-pill').getBoundingClientRect()
      const out = {}
      for (const q of ['.stepper-bar button', '.stepper-switch']) {
        const el = document.querySelector(q)
        scrollBy(0, el.getBoundingClientRect().bottom - innerHeight + 10)
        const under = el.getBoundingClientRect().bottom > pill.top
        el.focus()
        await new Promise((r) => setTimeout(r, 50))
        out[q] = [under, el.getBoundingClientRect().bottom <= pill.top]
      }
      return out
    })
    assert.deepEqual(r, { '.stepper-bar button': [true, true], '.stepper-switch': [true, true] }, JSON.stringify(viewport))
    await ctx.close()
  }
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
  const line = () => p.evaluate(() => [...document.querySelectorAll('.stepper-step.is-current .stepper-shared')].map((e) => getComputedStyle(e).display + ' ' + e.textContent))
  assert.deepEqual(await line(), ['block Network off. This step does not need it.'], 'with the switch off, a step both stories share says it does not need it')
  await p.click('.stepper-switch')
  assert.deepEqual(await line(), ['none Network off. This step does not need it.'], 'hidden with the switch on')
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
  const vis = () => p.evaluate(() => getComputedStyle(document.querySelector('.stepper-stage [data-part=db]')).visibility)
  assert.equal(await vis(), 'hidden', 'a data-future="hidden" part is hidden while future')
  await p.click('.stepper-bar button[data-step="2"]')
  assert.equal(await vis(), 'visible', 'and shown once its step arrives')
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
  const dir = mkdtempSync(join(tmpdir(), 'pf-pan-'))
  writeFileSync(join(dir, 'f.svg'), '<svg viewBox="0 0 720 60"><g data-part="a"><rect class="box" x="560" y="8" width="140" height="40"/></g><g data-part="anchor"/></svg>')
  writeFileSync(join(dir, 'pan.html'), renderPlan('# T\n\n```stepper figure=f.svg\n# One\nparts: a anchor\nkey: k\n```\n', { sourcePath: join(dir, 'p.md') }).html)
  const pan = await open({ viewport: { width: 390, height: 844 } }, join(dir, 'pan.html'))
  assert.ok(await pan.p.evaluate(() => {
    const s = document.querySelector('.stepper-stage').getBoundingClientRect(), r = document.querySelector('[data-part=a]').getBoundingClientRect()
    return r.left >= s.left && r.right <= s.right
  }), 'an empty anchor part does not pull the pan to x=0')
  await pan.ctx.close()
  // Viewbox 720 draws 576 wide; the stage is 358. a: 32..112, b: 464..560, c: 160..288, d: 336..382 (drawn px).
  writeFileSync(join(dir, 'g.svg'), '<svg viewBox="0 0 720 60"><g data-part="a"><rect class="box" x="40" y="8" width="100" height="40"/></g><g data-part="b"><rect class="box" x="580" y="8" width="120" height="40"/></g><g data-part="c"><rect class="box" x="200" y="8" width="160" height="40"/></g><g data-part="d"><rect class="box" x="420" y="8" width="57.5" height="40"/></g></svg>')
  const left = async (order) => {
    writeFileSync(join(dir, 'w.html'), renderPlan(`# T\n\n\`\`\`stepper figure=g.svg\n# One\nparts: ${order}\nkey: k\n\`\`\`\n`, { sourcePath: join(dir, 'p.md') }).html)
    const o = await open({ viewport: { width: 390, height: 844 } }, join(dir, 'w.html'))
    const r = await o.p.evaluate(() => {
      const s = document.querySelector('.stepper-stage'), sr = s.getBoundingClientRect()
      const whole = (n) => { const b = document.querySelector(`[data-part=${n}]`).getBoundingClientRect(); return b.left >= sr.left && b.right <= sr.right }
      return { left: s.scrollLeft, a: whole('a'), b: whole('b'), c: whole('c'), d: whole('d') }
    })
    await o.ctx.close()
    return r
  }
  const fits = await left('a c')
  assert.ok(fits.left === 0 && fits.a && fits.c, 'parts that fit from the start leave the view at the start: ' + JSON.stringify(fits))
  const snug = await left('d a')
  assert.ok(snug.a && snug.d, 'parts that fit only without the margin are still all whole: ' + JSON.stringify(snug))
  const ab = await left('a b'), ba = await left('b a')
  assert.ok(ab.a && !ab.b, 'too wide: the first part named stays whole (a): ' + JSON.stringify(ab))
  assert.ok(ba.b && !ba.a, 'too wide: the first part named stays whole (b): ' + JSON.stringify(ba))
  const cab = await left('c a b')
  assert.ok(cab.c && cab.a, 'too wide: with the first part whole, as many of the rest as fit (a, left of it): ' + JSON.stringify(cab))
  const cb = await left('c b')
  assert.ok(cb.c && cb.left === 0, 'too wide: among equal views, the one nearest the start: ' + JSON.stringify(cb))
})

await check('phone: a wide prose table scrolls in its own box and a wide image fits, so the page does not scroll sideways', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-wide-'))
  writeFileSync(join(dir, 'wide.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="90"><rect width="900" height="90" fill="#888"/></svg>')
  const cols = Array.from({ length: 8 }, (_, k) => 'column_heading_' + k)
  const md = `# T\n\n![wide](wide.svg)\n\n| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n| ${cols.join(' | ')} |\n`
  writeFileSync(join(dir, 'wide.html'), renderPlan(md, { sourcePath: join(dir, 'p.md') }).html)
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const p = await ctx.newPage()
  await p.goto('file://' + join(dir, 'wide.html')); await p.waitForFunction(() => document.querySelector('img').complete)
  const m = await p.evaluate(() => {
    const box = document.querySelector('.table-scroll'), img = document.querySelector('.plan-main img')
    return { page: document.documentElement.scrollWidth, scrolls: box.scrollWidth > box.clientWidth, img: img.getBoundingClientRect().width, natural: img.naturalWidth }
  })
  assert.equal(m.page, 390, JSON.stringify(m))
  assert.ok(m.scrolls, 'the table is wider than the page and scrolls in its box')
  assert.ok(m.natural === 900 && m.img <= 358, JSON.stringify(m))
  await ctx.close()
})

await check('a count drawn in the figure (a number state value) that just came on turns accent; a word value does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-count-'))
  writeFileSync(join(dir, 'f.svg'), '<svg viewBox="0 0 200 40"><g data-part="a"><rect class="box" x="0" y="0" width="40" height="40"/></g>'
    + ['n=0', 'n=1', 'n=2'].map((v) => `<text data-show="${v}" x="60" y="24">${v.slice(2)}</text>`).join('')
    + '<g data-show="door=open"><text x="100" y="24">open</text></g><g data-show="door=shut"><text x="100" y="24">shut</text></g></svg>')
  writeFileSync(join(dir, 'c.html'), renderPlan('# T\n\n```stepper figure=f.svg\nstate: n 0 1 2\nstate: door open shut\n\n# One\nparts: a\nset: n=1, door=shut\nkey: k\n\n# Two\nparts: a\nset: n=2\nkey: k\n\n# Three\nparts: a\nkey: k\n```\n', { sourcePath: join(dir, 'p.md') }).html)
  const { p, ctx } = await open({}, join(dir, 'c.html'))
  const marked = () => p.evaluate(() => [...document.querySelectorAll('[data-show].is-changed')].map((g) => g.dataset.show))
  assert.deepEqual(await marked(), ['n=1'], 'step 1: the count is marked, the door is not')
  const fill = await p.evaluate(() => getComputedStyle(document.querySelector('text[data-show="n=1"]')).fill)
  assert.ok(near(fill.match(/\d+/g).slice(0, 3).map(Number), await token(p, '--accent')), `marked text is accent, got ${fill}`)
  await p.click('.stepper-next')
  assert.deepEqual(await marked(), ['n=2'])
  await p.click('.stepper-next')
  assert.deepEqual(await marked(), [], 'a kept count is not marked')
  await ctx.close()
})

await check('a plain #heading link from another page lands on the h: heading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-hash-'))
  writeFileSync(join(dir, 'far.html'), renderPlan('# T\n\n' + 'Filler.\n\n'.repeat(150) + '## Far down\n\nHere.\n', { sourcePath: join(dir, 'p.md') }).html)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }), p = await ctx.newPage()
  await p.goto('file://' + join(dir, 'far.html') + '#far-down')
  await p.waitForFunction(() => { const r = document.getElementById('h:far-down').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }, null, { timeout: 3000 })
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
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('.stepper-stage [data-part=db]')).visibility), 'visible', 'hidden-future parts print')
  await ctx.close()
})

await check('figure: grows to 1.25x when the column has room, so 12-unit text reads at 15px, and the dark theme repaints the ink', async () => {
  const { p, ctx } = await open({ colorScheme: 'dark' })
  const m = await p.evaluate(() => {
    const svg = document.querySelector('.figure-stage svg')
    const t = svg.querySelector('text')
    return { w: svg.getBoundingClientRect().width, stroke: getComputedStyle(svg.querySelector('rect')).stroke, fg: getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() }
  })
  assert.equal(m.w, 900, 'a 720-unit figure in the 952px column')
  const fg = await token(p, '--fg')
  assert.equal(m.stroke, `rgb(${fg.join(', ')})`)
  await p.locator('figure[data-block=figure]').screenshot({ path: join(out, 'figure-dark.png') })
  await ctx.close()
})

console.log('\n# flow pulses')

// The e-gateway line (M160 100H208) is 48 long, so its cycle is (48 + 14) * 12 = 744ms and the
// 14-unit bead's centre is 62t/744 - 7 along it. Freeze it and read the device pixel (at 2x)
// just above the line at x=178, clear of the boundary at x=184. The pulse is wider than the
// line, so that pixel is accent only while the pulse passes it.
const pulsePixel = async (p, ms, x = 178) => {
  const pt = await p.evaluate(async ({ ms, x }) => {
    await Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished))
    const c = document.querySelector('.stepper-stage [data-part=e-gateway] .flow-pulse')
    c.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms })
    const svg = c.ownerSVGElement, m = svg.getScreenCTM(), q = svg.createSVGPoint()
    q.x = x; q.y = 98.75
    const s = q.matrixTransform(m)
    return { x: Math.floor(s.x * 2), y: Math.floor(s.y * 2) }
  }, { ms, x })
  return pixel(p, await p.screenshot(), pt.x, pt.y)
}

await check('only data-flow lines of current parts pulse, in drawing direction, in accent, three runs then rest', async () => {
  const { p, ctx, errors } = await open({ deviceScaleFactor: 2 })
  const pulses = () => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.flow-pulse')].map((c) =>
    [c.closest('[data-part]').dataset.part, getComputedStyle(c).display !== 'none' && c.getAnimations().length > 0])))
  assert.deepEqual(await pulses(), { 'e-gateway': false, 'e-service': false }, 'one pulse per data-flow line, none running on step 1')
  await p.click('.stepper-next')
  assert.deepEqual(await pulses(), { 'e-gateway': true, 'e-service': false })
  const offsets = await p.evaluate(() => {
    const c = document.querySelector('[data-part=e-gateway] .flow-pulse')
    return [100, 300, 500].map((ms) => {
      c.getAnimations().forEach((a) => { a.pause(); a.currentTime = ms })
      return parseFloat(getComputedStyle(c).strokeDashoffset)
    })
  })
  assert.ok(offsets[0] > offsets[1] && offsets[1] > offsets[2], `offset falls, so the dash runs start to end: ${offsets}`)
  const bg = await token(p, '--bg'), accent = await token(p, '--accent')
  const on = await pulsePixel(p, 300), off = await pulsePixel(p, 564)
  assert.ok(near(on, accent, 40), `pulse passing x=178 paints accent: ${on} vs ${accent}`)
  assert.ok(near(off, bg), `pulse elsewhere leaves the background: ${off} vs ${bg}`)
  const run = await p.evaluate(() => document.querySelector('[data-part=e-gateway] .flow-pulse').getAnimations()[0].effect.getComputedTiming().duration)
  assert.ok(near(await pulsePixel(p, 2 * run + 300), accent, 40), 'the third run still paints')
  for (const x of [166, 178, 200]) assert.ok(near(await pulsePixel(p, 3 * run + 300, x), bg), `after three runs the bead rests out of sight (x=${x})`)
  await p.click('.stepper-next')
  assert.deepEqual(await pulses(), { 'e-gateway': false, 'e-service': true })
  assert.deepEqual(errors, [])
  await ctx.close()
})

await check('flow pulses are off under reduced motion, in print and without script', async () => {
  const shown = (p) => p.evaluate(() => [...document.querySelectorAll('.flow-pulse')].filter((c) => getComputedStyle(c).display !== 'none').length)
  const rm = await open({ reducedMotion: 'reduce' })
  await rm.p.click('.stepper-next')
  assert.equal(await rm.p.locator('.flow-pulse').count(), 2, 'pulses exist')
  assert.equal(await shown(rm.p), 0, 'reduced motion')
  await rm.ctx.close()
  const pr = await open()
  await pr.p.click('.stepper-next')
  assert.equal(await shown(pr.p), 1, 'one pulse on screen')
  await pr.p.emulateMedia({ media: 'print' })
  assert.equal(await shown(pr.p), 0, 'print')
  await pr.ctx.close()
  const nj = await open({ javaScriptEnabled: false })
  assert.equal(await nj.p.locator('.flow-pulse').count(), 0, 'no script')
  await nj.ctx.close()
})

const compositeSrc = join(here, 'fixtures', 'composite.md'), composite = join(out, 'composite.html')
writeFileSync(composite, renderPlan(readFileSync(compositeSrc, 'utf8'), { sourcePath: compositeSrc }).html)

await check('code captions: a bulleted list at the small size', async () => {
  const { p, ctx, errors } = await open({}, composite)
  const st = await p.evaluate(() => {
    const ul = document.querySelector('.stepper-step.is-current .stepper-code ul')
    const code = ul.querySelector('code'), cs = (e) => getComputedStyle(e)
    return { list: cs(ul.firstElementChild).display + ' ' + cs(ul).listStyleType, code: cs(code).fontSize, label: cs(document.querySelector('.stepper-step.is-current .stepper-code .stepper-label')).fontSize, rows: ul.children.length, height: ul.firstElementChild.getBoundingClientRect().height }
  })
  assert.equal(st.list, 'list-item disc')
  assert.equal(st.code, '12px', 'the path is at --fs-xs, not the 16px a list item gives inline code')
  assert.equal(st.label, '12px')
  assert.equal(st.rows, 2)
  assert.ok(st.height < 24, `one line per path: ${st.height}px`)
  assert.deepEqual(errors, [])
  await ctx.close()
})

await check('a composite card\'s link is accent, underlined, and jumps to its exploded figure', async () => {
  const { p, ctx, errors } = await open({}, composite)
  const link = p.locator('.stepper-stage [data-part=workers] a')
  const st = await link.evaluate((a) => ({ fill: getComputedStyle(a.querySelector('text')).fill, deco: getComputedStyle(a).textDecorationLine }))
  assert.deepEqual(st.fill.match(/\d+/g).slice(0, 3).map(Number), await token(p, '--accent'))
  assert.equal(st.deco, 'underline')
  await link.click()
  assert.equal(await p.evaluate(() => location.hash), '#stepper:inside-the-workers')
  assert.equal(await p.locator('figure[data-block=stepper]').first().locator('.stepper-bar [aria-current=step]').textContent(), '1', 'the link does not also step to the card')
  const inView = () => { const t = document.getElementById('stepper:inside-the-workers').getBoundingClientRect().top; return scrollY > 0 && t >= 0 && t < innerHeight / 2 }
  await p.waitForFunction(inView, null, { timeout: 3000 }).catch(() => {})
  assert.ok(await p.evaluate(inView), `the exploded figure's top is in the upper half of the view: ${await p.evaluate(() => [scrollY, document.getElementById('stepper:inside-the-workers').getBoundingClientRect().top])}`)
  assert.deepEqual(errors, [])
  await ctx.close()
})

await check('a plan building rises while current; clicking a part goes to its step; hovering hints at it', async () => {
  const { p, ctx, errors } = await open({}, composite)
  const fig = p.locator('#stepper\\:inside-the-workers')
  const settle = () => fig.evaluate(async (f) => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return Promise.all(f.getAnimations({ subtree: true }).filter((a) => a.transitionProperty).map((a) => a.finished.catch(() => {}))) })
  const look = (n) => fig.evaluate((f, n) => { const g = f.querySelector(`[data-part="${n}"]`), c = getComputedStyle(g); return [c.transform, c.color, c.cursor] }, n)
  const current = () => fig.locator('.stepper-bar [aria-current=step]').textContent()
  await settle()
  assert.equal((await look('queue'))[0], 'matrix(1, 0, 0, 1, 0, -12)', 'the current building rises 12')
  assert.equal((await look('w-email'))[0], 'none')
  assert.equal((await look('w-email'))[2], 'pointer')
  await fig.locator('[data-part="w-email"] text').first().click()
  assert.equal(await current(), '3', 'clicking a label goes to the step that names its part')
  await fig.locator('[data-part="queue"] text').first().click()
  assert.equal(await current(), '1', 'steps 1 and 5 name the queue; the first wins')
  await fig.locator('[data-part="store"] text').first().click()
  assert.equal(await current(), '5')
  await fig.locator('[data-part="queue"] text').first().click()
  assert.equal(await current(), '5', 'the queue is first named at step 1, but step 5 names it too, so the stepper stays')
  await p.mouse.move(0, 0); await settle()
  const rest = await look('w-search')
  await fig.locator('[data-part="w-search"] text').first().hover(); await settle()
  const hover = await look('w-search')
  assert.equal(rest[0], 'none')
  assert.equal(hover[0], 'matrix(1, 0, 0, 1, 0, -4)', 'a hovered building lifts a little')
  assert.notEqual(hover[1], rest[1], 'and takes a hint of accent')
  await fig.locator('[data-part="store"] text').first().hover(); await settle()
  assert.equal((await look('store'))[0], 'matrix(1, 0, 0, 1, 0, -12)', 'hover does not pull a current building down')
  await p.emulateMedia({ media: 'print' })
  assert.equal((await look('store'))[0], 'none', 'print is flat')
  assert.deepEqual(errors, [])
  await ctx.close()
})

await check('a data-lift layer rises only while current, the layers over it are ghosted, and print is flat', async () => {
  const { p, ctx, errors } = await open({}, composite)
  const fig = p.locator('#stepper\\:four-layers')
  const lifts = () => fig.evaluate((f) => Object.fromEntries([...f.querySelectorAll('[data-lift]')].map((g) => [g.dataset.part, getComputedStyle(g).transform])))
  const ghosts = () => fig.evaluate((f) => [...f.querySelectorAll('[data-lift]')].map((g) => getComputedStyle(g).opacity))
  await p.waitForFunction(() => getComputedStyle(document.querySelector('#stepper\\:four-layers [data-part=interface]')).transform !== 'none')
  await fig.evaluate((f) => Promise.all(f.getAnimations({ subtree: true }).map((a) => a.finished)))
  assert.deepEqual(await lifts(), { storage: 'none', services: 'none', api: 'none', interface: 'matrix(1, 0, 0, 1, 0, -20)' })
  await fig.locator('.stepper-next').click()
  await fig.evaluate((f) => Promise.all(f.getAnimations({ subtree: true }).map((a) => a.finished)))
  assert.deepEqual(await lifts(), { storage: 'none', services: 'none', api: 'matrix(1, 0, 0, 1, 0, -20)', interface: 'none' })
  assert.deepEqual(await ghosts(), ['1', '0.32', '1', '0.16'], 'storage is context, services future (faint), interface is drawn over the api so it is ghosted')
  await p.emulateMedia({ media: 'print' })
  assert.deepEqual(Object.values(await lifts()), ['none', 'none', 'none', 'none'])
  assert.deepEqual(await ghosts(), ['1', '1', '1', '1'])
  assert.deepEqual(errors, [])
  await ctx.close()
})

await check('switch off shows an off: step in place of the one step it names, with its own state', async () => {
  const { p, ctx, errors } = await open({}, composite)
  const fig = p.locator('figure[data-block=stepper]').first()
  const look = () => fig.evaluate((f) => ({
    visible: [...f.querySelectorAll('.stepper-step')].filter((s) => s.offsetParent).map((s) => s.querySelector('h3').textContent),
    on: [...f.querySelectorAll('[data-show][data-on]')].map((g) => g.dataset.show),
    parts: Object.fromEntries(['api', 'workers', 'store'].map((n) => [n, f.querySelector(`[data-part="${n}"]`).dataset.state])),
  }))
  await fig.locator('.stepper-switch').click()
  assert.deepEqual((await look()).visible, ['A request becomes a job'], 'other steps are unchanged')
  await fig.locator('.stepper-bar button[data-step="2"]').click()
  assert.deepEqual(await look(), { visible: ['The job goes back'], on: ['queue=one'], parts: { api: 'past', workers: 'past', store: 'current' } })
  assert.equal(await fig.locator('.stepper-bar [aria-current=step]').textContent(), '3', 'the bar stays on the step it stands in for')
  await fig.locator('.stepper-switch').click()
  assert.deepEqual(await look(), { visible: ['The result is stored'], on: ['queue=empty'], parts: { api: 'past', workers: 'past', store: 'current' } })
  assert.deepEqual(errors, [])
  await ctx.close()
})

await check('switch off: past parts and values follow the off story, a held step keeps it, and the figure can show the switch', async () => {
  mkdirSync(join(out, 'figures'), { recursive: true })
  writeFileSync(join(out, 'figures', 'off.svg'), '<svg viewBox="0 0 200 40">' + ['a', 'b', 'c', 'd', 'h'].map((n, k) => `<g data-part="${n}"><rect class="box" x="${k * 40}" y="0" width="30" height="20"/></g>`).join('')
    + ['slip=lifted', 'pen=down', 'switch=on', 'switch=off'].map((v) => `<g data-show="${v}"><text x="0" y="36">${v}</text></g>`).join('') + '</svg>')
  const page = join(out, 'off.html')
  writeFileSync(page, renderPlan('# Off\n\n```stepper figure=figures/off.svg\ncounter: n | Acknowledged\nstate: slip flat lifted\nstate: pen up down\nswitch: Net\n'
    + '# One\nparts: a\nset: n=1\nkey: k\n# Two\nparts: b\nneeds: switch\nset: n=5\nkey: k\n# End\nparts: c\nset: n=9, slip=lifted\nkey: k\n'
    + '# End offline\noff: End\nparts: d\nset: slip=lifted\nkey: k\n# After\nparts: b\nneeds: switch\nset: n=7\nkey: k\n# Held\nheld\nparts: h\nset: pen=down\nkey: k\n```\n', { sourcePath: join(out, 'off.md') }).html)
  const { p, ctx, errors } = await open({}, page)
  const look = () => p.evaluate(() => ({
    parts: [...document.querySelectorAll('[data-part]')].map((g) => g.dataset.state).join(' '),
    on: [...document.querySelectorAll('[data-show][data-on]')].map((g) => g.dataset.show).join(' '),
    n: document.querySelector('.stepper-counter b').textContent,
  }))
  const step = (n) => p.locator(`.stepper-bar button[data-step="${n}"]`).click()
  await p.locator('.stepper-switch').click()
  assert.deepEqual(await look(), { parts: 'current future future future future', on: 'switch=off', n: '1' }, 'at step 1 the figure already knows the switch is off')
  await step(2)
  assert.deepEqual(await look(), { parts: 'past future future current future', on: 'slip=lifted switch=off', n: '1' }, 'Two was never seen, so b stays future and nothing it counted is counted')
  await step(3)
  assert.deepEqual(await look(), { parts: 'past future future past current', on: 'slip=lifted pen=down switch=off', n: '1' }, 'the held step keeps the lifted slip, then its own set:')
  await p.locator('.stepper-switch').click()
  assert.deepEqual(await look(), { parts: 'past current past future future', on: 'slip=lifted switch=on', n: '7' })
  assert.deepEqual(errors, [])
  await ctx.close()
})

await check('a state: shows one data-show group per value, fades between them as steps set it, and mono labels use the mono font', async () => {
  const { p, ctx, errors } = await open({}, composite)
  const fig = p.locator('figure[data-block=stepper]').first()
  const shown = () => fig.evaluate(async (f) => {
    await Promise.all(f.getAnimations({ subtree: true }).filter((a) => a.transitionProperty).map((a) => a.finished))
    return Object.fromEntries([...f.querySelectorAll('[data-show]')].map((g) => { const c = getComputedStyle(g); return [g.dataset.show, c.visibility === 'visible' && c.opacity === '1'] }))
  })
  const changed = () => fig.evaluate((f) => [...f.querySelectorAll('[data-show].is-changed')].map((g) => g.dataset.show))
  assert.deepEqual(await shown(), { 'queue=empty': false, 'queue=one': true }, 'step 1 sets queue=one')
  assert.deepEqual(await changed(), [], 'a word value is not a count, so it is not marked')
  await fig.locator('.stepper-next').click()
  const mid = await fig.evaluate((f) => getComputedStyle(f.querySelector('[data-show="queue=empty"]')).transitionDuration)
  assert.notEqual(mid, '0s', 'the swap fades')
  assert.deepEqual(await shown(), { 'queue=empty': true, 'queue=one': false })
  await fig.locator('.stepper-next').click()
  assert.deepEqual(await shown(), { 'queue=empty': true, 'queue=one': false }, 'a state not set keeps its value')
  await fig.locator('.stepper-prev').click(); await fig.locator('.stepper-prev').click()
  assert.deepEqual(await shown(), { 'queue=empty': false, 'queue=one': true }, 'going back restores the earlier value')
  const fonts = await fig.evaluate((f) => [getComputedStyle(f.querySelector('text.mono')).fontFamily, getComputedStyle(document.querySelector('code')).fontFamily, getComputedStyle(f.querySelector('[data-part=api] text:not(.mono)')).fontFamily])
  assert.equal(fonts[0], fonts[1], 'a mono label uses the page mono font')
  assert.notEqual(fonts[0], fonts[2])
  const text = await fig.evaluate((f) => {
    const cs = (sel) => getComputedStyle(f.querySelector(sel))
    return { sizes: [...new Set([...f.querySelectorAll('.stepper-stage text')].map((t) => getComputedStyle(t).fontSize))], name: cs('[data-part=queue] text:not(.muted)').fontWeight, caption: cs('[data-part=queue] text.muted').fontWeight }
  })
  assert.deepEqual(text, { sizes: ['12px'], name: '600', caption: '400' }, 'one text size in a figure; a name stands out by weight only')
  await p.emulateMedia({ media: 'print' })
  assert.deepEqual(await shown(), { 'queue=empty': true, 'queue=one': false }, 'print shows the first value, whatever step is on screen')
  assert.deepEqual(errors, [])
  await ctx.close()
  const nj = await open({ javaScriptEnabled: false }, composite)
  assert.deepEqual(await nj.p.locator('figure[data-block=stepper]').first().evaluate((f) => [...f.querySelectorAll('[data-show]')].map((g) => getComputedStyle(g).visibility)), ['visible', 'hidden'], 'without script the first value shows')
  await nj.ctx.close()
  const rm = await open({ reducedMotion: 'reduce' }, composite)
  assert.equal(await rm.p.locator('[data-show="queue=empty"]').first().evaluate((g) => getComputedStyle(g).transitionDuration), '0s')
  await rm.ctx.close()
})

await check('a technology mark is a filled, faint watermark inside its box: ink at 0.3, accent at 0.55 while current', async () => {
  const { p, ctx, errors } = await open({}, composite)
  const fig = p.locator('figure[data-block=stepper]').first()
  await fig.evaluate((f) => f.scrollIntoView())
  const at = () => fig.evaluate(async (f) => {
    await Promise.all(f.getAnimations({ subtree: true }).map((a) => a.finished))
    const r = f.querySelector('use.mark').getBoundingClientRect(), b = f.querySelector('[data-part=queue] .box').getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), inside: r.left > b.left && r.right < b.right && r.top > b.top && r.bottom < b.bottom }
  })
  const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t))
  let c = await at()
  assert.ok(c.inside, 'the mark sits inside the box')
  const accent = await token(p, '--accent'), soft = await token(p, '--accent-soft'), fg = await token(p, '--fg'), bg = await token(p, '--bg')
  let px = await pixel(p, await p.screenshot(), c.x, c.y)
  assert.ok(near(px, mix(soft, accent, 0.55), 8), `current: accent at 0.55 over the box fill, filled at its centre: ${px} vs ${mix(soft, accent, 0.55)}`)
  await fig.locator('.stepper-next').click()
  c = await at()
  px = await pixel(p, await p.screenshot(), c.x, c.y)
  assert.ok(near(px, mix(bg, fg, 0.3), 8), `past: ink at 0.3: ${px} vs ${mix(bg, fg, 0.3)}`)
  assert.deepEqual(errors, [])
  await ctx.close()
})

const [, , planW, planH] = /viewBox="([^"]+)"/.exec(readFileSync(join(here, 'fixtures', 'figures', 'workers-plan.svg'), 'utf8'))[1].split(' ').map(Number)
const planAspect = planH / planW

await check('a stepper widens past the prose column to fit its figure and rail, clear of the side nav, sticky within the window', async () => {
  const chapters = join(out, 'composite-chapters.html')
  writeFileSync(chapters, renderPlan(readFileSync(compositeSrc, 'utf8').replace(/^(---\n[\s\S]*?\n---\n)/, '$1\n<!-- chapter: One -->\n\nIntro.\n\n'), { sourcePath: compositeSrc }).html)
  const box = (p, sel = 'figure[data-block=stepper]') => p.evaluate((sel) => {
    const f = document.querySelector(sel), r = (e) => e.getBoundingClientRect()
    const st = r(f), main = document.querySelector('.plan-main'), cs = getComputedStyle(main)
    const nav = document.body.hasAttribute('data-has-chapters') ? r(document.querySelector('.pf-sidenav')) : null
    return { left: st.left, right: innerWidth - st.right, width: st.width, prose: main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      svg: r(f.querySelector('.stepper-stage svg')), rail: r(f.querySelector('.stepper-steps')).width, sticky: r(f.querySelector('.stepper-main')).height,
      navRight: nav ? nav.right : 0, overflow: document.documentElement.scrollWidth - innerWidth }
  }, sel)
  let { p, ctx } = await open({ viewport: { width: 1920, height: 1080 } }, composite)
  let b = await box(p)
  assert.equal(b.width, 640 * 1.25 + 360 + 32, 'as wide as the figure at 1.25x, the 360px rail and the gap, no wider')
  assert.equal(Math.round(b.svg.width), 800)
  assert.equal(Math.round(b.rail), 360)
  assert.ok(Math.abs(b.left - b.right) < 1 && b.overflow === 0, JSON.stringify(b))
  await ctx.close()
  const wideSvg = readFileSync(join(here, 'fixtures', 'figures', 'job-queue.svg'), 'utf8').replace('viewBox="0 0 640 256"', 'viewBox="0 0 1200 256"')
  mkdirSync(join(out, 'figures'), { recursive: true })
  writeFileSync(join(out, 'figures', 'wide.svg'), wideSvg)
  const widePage = join(out, 'wide.html')
  writeFileSync(widePage, renderPlan('# Wide\n\n```stepper figure=figures/wide.svg\n# One\nparts: api\nkey: k\n```\n', { sourcePath: join(out, 'wide.md') }).html)
  ;({ p, ctx } = await open({ viewport: { width: 2560, height: 1200 } }, widePage))
  b = await box(p)
  assert.equal(b.width, 1440 - 48, 'a wide figure stops at a 1440px page')
  await ctx.close()
  ;({ p, ctx } = await open({ viewport: { width: 1280, height: 800 } }, chapters))
  b = await box(p)
  assert.ok(b.navRight === 240 && b.left >= b.navRight + 24 && b.right >= 24, `clear of the nav and the window edge: ${JSON.stringify(b)}`)
  assert.ok(b.width > b.prose && b.overflow === 0, JSON.stringify(b))
  await ctx.close()
  ;({ p, ctx } = await open({ viewport: { width: 1440, height: 600 } }, composite))
  b = await box(p, '#stepper\\:inside-the-workers')
  assert.ok(b.sticky <= 600 - 64, `the sticky figure column fits under the top bar: ${b.sticky}px`)
  assert.ok(b.svg.height < b.svg.width * planAspect, `the drawing is capped by the window height: ${b.svg.height}`)
  await ctx.close()
  ;({ p, ctx } = await open({ viewport: { width: 390, height: 800 } }, chapters))
  b = await box(p)
  assert.ok(b.width === b.prose && b.overflow === 0, JSON.stringify(b))
  await ctx.close()
  ;({ p, ctx } = await open({ viewport: { width: 1920, height: 600 } }, composite))
  await p.emulateMedia({ media: 'print' })
  b = await box(p, '#stepper\\:inside-the-workers')
  assert.equal(b.width, b.prose, 'print keeps the stepper in the column')
  assert.ok(Math.abs(b.svg.height - b.svg.width * planAspect) < 1, 'print does not cap the height')
  await ctx.close()
})

console.log('\n# theme toggle')

await check('theme: follows the system until clicked, stores only a click, icon only', async () => {
  const { p, ctx, errors } = await open({ colorScheme: 'dark' })
  const st = () => p.evaluate(() => ({ theme: document.documentElement.dataset.theme, saved: localStorage.getItem('pf-theme') }))
  const themeIs = (t) => p.waitForFunction((t) => document.documentElement.dataset.theme === t, t, { timeout: 2000 }).catch(() => {})
  assert.deepEqual(await st(), { theme: 'dark', saved: null }, 'system dark, nothing stored on load')
  assert.equal((await p.locator('.theme-toggle').innerText()).trim().length <= 1, true, 'the toggle shows an icon, no label')
  await p.emulateMedia({ colorScheme: 'light' })
  await themeIs('light')
  assert.deepEqual(await st(), { theme: 'light', saved: null }, 'follows a live system change')
  await p.click('.theme-toggle')
  assert.deepEqual(await st(), { theme: 'dark', saved: 'dark' }, 'a click flips and stores')
  // Media query changes are reported once per frame, so let each flip land.
  for (const c of ['dark', 'light']) {
    await p.emulateMedia({ colorScheme: c })
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  }
  await themeIs('light')
  assert.equal((await st()).theme, 'dark', 'a stored choice beats later system changes')
  await p.reload()
  assert.deepEqual(await st(), { theme: 'dark', saved: 'dark' }, 'and survives a reload')
  assert.deepEqual(errors, [])
  await ctx.close()
})

console.log('\n# embed in a browser')

const embedFixture = join(here, 'fixtures', 'embed.md')
const embedPage = join(out, 'embed.html')
writeFileSync(embedPage, renderPlan(readFileSync(embedFixture, 'utf8'), { sourcePath: embedFixture }).html)
const frame = async (p) => (await (await p.waitForSelector('.embed-stage iframe')).contentFrame())

await check('poster first; Run swaps in a sandboxed frame that gets the page tokens', async () => {
  const { p, ctx, errors } = await open({}, embedPage)
  assert.equal(await p.isVisible('.embed-poster'), true)
  assert.equal(await p.locator('.embed-stage iframe').count(), 0, 'nothing runs before Run')
  await p.click('.embed-run')
  assert.equal(await p.isVisible('.embed-poster'), false)
  assert.equal(await p.getAttribute('.embed-stage iframe', 'sandbox'), 'allow-scripts')
  assert.equal(await p.evaluate(() => document.querySelector('.embed-stage iframe').getBoundingClientRect().height), 300)
  const f = await frame(p)
  await f.waitForSelector('#out')
  await f.fill('#len', '60')
  assert.equal(await f.textContent('#out'), '60', 'the embed script runs')
  assert.equal(await f.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fg').trim()), await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fg').trim()))
  await p.locator('figure[data-block=embed]').screenshot({ path: join(out, 'embed-running.png') })
  assert.deepEqual(errors, [])
  await ctx.close()
})

await check('a theme change reloads a running embed with the new tokens', async () => {
  const { p, ctx } = await open({}, embedPage)
  await p.click('.embed-run')
  await (await frame(p)).waitForSelector('#out')
  await p.click('[data-theme-toggle]')
  await p.waitForTimeout(200)
  const f = await frame(p)
  await f.waitForSelector('#out')
  const bg = await f.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
  assert.equal(bg, await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()))
  assert.equal(await p.getAttribute('html', 'data-theme'), 'dark')
  await ctx.close()
})

await check('no script and print show the poster only', async () => {
  const nojs = await open({ javaScriptEnabled: false }, embedPage)
  assert.equal(await nojs.p.isVisible('.embed-poster'), true)
  assert.equal(await nojs.p.isVisible('.embed-run'), false)
  await nojs.ctx.close()
  const { p, ctx } = await open({}, embedPage)
  await p.click('.embed-run')
  await p.emulateMedia({ media: 'print' })
  assert.equal(await p.isVisible('.embed-poster'), true)
  assert.equal(await p.isVisible('.embed-stage iframe'), false)
  await ctx.close()
})

// A hostile embed against a local HTTP and UDP listener: count what reaches them.
const { createServer } = await import('node:http')
const { createSocket } = await import('node:dgram')
const hits = []
const server = createServer((req, res) => {
  hits.push(req.url)
  if (req.url === '/hang') res.write('<img src="/never"><script>fetch("/followup")</script>')
  else if (req.url !== '/never') res.end('x')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const udp = createSocket('udp4')
const udpHits = []
udp.on('message', () => udpHits.push(1))
await new Promise((r) => udp.bind(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const dir = mkdtempSync(join(tmpdir(), 'pf-embed-'))
writeFileSync(join(dir, 'poster.svg'), readFileSync(join(here, 'fixtures', 'embeds', 'pendulum.svg')))
const hostile = () => `<!doctype html><html><head>
<link rel="stylesheet" href="${base}/link-css"><link rel="prefetch" href="${base}/prefetch">
<style>body { background: url(${base}/css-url) }</style>
<script src="${base}/script-src"></script></head><body>
<img src="${base}/img-tag"><form action="${base}/form" method="post"><button>x</button></form>
<script>
  const r = {}
  const tryIt = (k, f) => { try { r[k] = String(f()) } catch (e) { r[k] = 'threw' } }
  tryIt('parentDoc', () => parent.document.title)
  tryIt('localStorage', () => localStorage.length)
  tryIt('cookie', () => document.cookie)
  tryIt('open', () => window.open('${base}/popup'))
  tryIt('topNav', () => { top.location = '${base}/top-nav'; return 'set' })
  tryIt('form', () => { document.forms[0].submit(); return 'submitted' })
  tryIt('beacon', () => navigator.sendBeacon('${base}/beacon', 'x'))
  tryIt('ws', () => new WebSocket('${base.replace('http', 'ws')}/ws'))
  new Image().src = '${base}/img-js'
  const x = new XMLHttpRequest(); tryIt('xhr', () => { x.open('GET', '${base}/xhr'); x.send(); return 'sent' })
  fetch('${base}/fetch').then(() => { r.fetch = 'ok' }, () => { r.fetch = 'blocked' })
  tryIt('rtc', () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udp.address().port}' }] })
    pc.createDataChannel('d'); pc.createOffer().then((o) => pc.setLocalDescription(o)); return 'created'
  })
  setTimeout(() => parent.postMessage(r, '*'), 1500)
</script></body></html>`
const hostilePage = (html, name) => {
  writeFileSync(join(dir, `${name}.html`), html)
  const md = '```embed src=' + name + '.html poster=poster.svg title=Hostile\nx\n```\n'
  const file = join(dir, `page-${name}.html`)
  writeFileSync(file, renderPlan(md, { sourcePath: join(dir, 'p.md') }).html)
  return file
}

await check('a hostile embed reaches nothing over HTTP and cannot touch the page', async () => {
  hits.length = 0
  const { p, ctx } = await open({}, hostilePage(hostile(), 'hostile'))
  const report = p.evaluate(() => new Promise((res) => addEventListener('message', (e) => res(e.data), { once: true })))
  await p.click('.embed-run')
  const r = await report
  await p.waitForTimeout(1500)
  assert.deepEqual(hits, [], 'HTTP requests that got out')
  assert.equal(r.parentDoc, 'threw')
  assert.equal(r.localStorage, 'threw')
  assert.equal(r.cookie, 'threw')
  assert.equal(r.open, 'null')
  assert.equal(r.fetch, 'blocked')
  assert.equal(await p.locator('.embed-stage iframe').count(), 1, 'still running: no navigation happened')
  console.log(`          (WebRTC STUN packets that got out: ${udpHits.length}; report ${JSON.stringify(r)})`)
  await ctx.close()
})

await check('an embed cannot navigate its own frame anywhere (the page sets frame-src none)', async () => {
  const navs = {
    inline: `<script>location.href = '${base}/nav-inline'</script>`,
    delayed: `<p id="x">x</p><script>setTimeout(() => { location.href = '${base}/nav-delayed' }, 200)</script>`,
    refresh: `<meta http-equiv="refresh" content="0;url=${base}/nav-refresh">`,
    hanging: `<script>setTimeout(() => { location.href = '${base}/hang' }, 200)</script>`,
  }
  for (const [name, html] of Object.entries(navs)) {
    hits.length = 0
    const { p, ctx } = await open({}, hostilePage(html, name))
    await p.click('.embed-run')
    await p.waitForTimeout(1200)
    assert.deepEqual(hits, [], `${name}: requests that got out`)
    assert.equal(await p.locator('.embed-stage iframe').count(), 1, name)
    await ctx.close()
  }
})

await check('check.mjs reports labels that spill or overlap and text drawn too small, not hidden or unoutlined ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-layout-'))
  mkdirSync(join(dir, 'figures'))
  writeFileSync(join(dir, 'figures', 'layout.svg'), '<svg viewBox="0 0 360 120">'
    + '<g data-part="spill"><rect class="box" x="0" y="0" width="60" height="40"/><text x="8" y="24">A label far too long</text></g>'
    + '<g data-part="fits"><rect class="box" x="0" y="60" width="160" height="40"/><text x="12" y="84">Fits</text></g>'
    + '<g data-part="tight"><rect class="box" x="180" y="60" width="40" height="40"/><text x="181" y="84">Tight</text></g>'
    + '<g data-part="bare"><rect class="box" style="stroke:none" x="250" y="60" width="40" height="40"/><text x="251" y="84">Bare</text></g>'
    + '<text x="200" y="24">Left</text><text x="210" y="24">Right</text></svg>')
  writeFileSync(join(dir, 'figures', 'show.svg'), '<svg viewBox="0 0 360 60"><g data-part="a"><rect class="box" x="0" y="0" width="160" height="40"/><text x="12" y="24">Shown</text></g>'
    + '<g data-show="switch=off"><text x="20" y="24">Hidden over it</text></g>'
    + '<g data-part="chip"><g data-show="switch=on"><rect class="box" x="200" y="0" width="150" height="40"/><text x="212" y="24">Wide chip label</text></g>'
    + '<g data-show="switch=off"><rect class="box" x="200" y="0" width="40" height="40"/></g></g></svg>')
  writeFileSync(join(dir, 'figures', 'wide.svg'), '<svg viewBox="0 0 2400 60"><g data-part="a"><rect class="box" x="0" y="0" width="160" height="40"/><text x="12" y="24">Tiny</text></g></svg>')
  const file = join(dir, 'layout.html')
  writeFileSync(file, renderPlan('# Layout\n\n```figure src=figures/layout.svg title="Layout"\nBoxes.\n```\n\n```figure src=figures/wide.svg title="Wide"\nWide.\n```\n\n'
    + '```stepper figure=figures/show.svg title="Show"\nswitch: Net\n\n# One\nneeds: switch\nparts: a\nkey: k\n\n# Two\noff: One\nparts: a\nkey: k\n```\n', { sourcePath: join(dir, 'layout.md') }).html)
  const r = spawnSync(process.execPath, [join(here, '..', 'check.mjs'), file, '--browser', chromium.executablePath()], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const warnings = r.stderr.split('\n').filter((l) => l.startsWith('warning: ')).sort()
  assert.equal(warnings.length, 4, warnings.join('\n'))
  assert.equal(warnings[0], 'warning: Layout: label "A label far too long" touches or spills out of its box')
  assert.equal(warnings[1], 'warning: Layout: label "Tight" touches or spills out of its box')
  assert.equal(warnings[2], 'warning: Layout: labels "Left" and "Right" overlap')
  assert.match(warnings[3], /^warning: Wide: text shows at \d+(\.\d)?px; draw the figure narrower/)
  assert.match(r.stdout, /4 figure layout warning\(s\)/)
  assert.ok(readFileSync(file, 'utf8').indexOf('present-check-layout') < 0, 'the checked page is left untouched')
})

server.close(); udp.close()
await browser.close()
console.log(`\nshots: ${out}\nTotal: ${passed} passed, ${failed} failed`)
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
process.exit(failed ? 1 : 0)
