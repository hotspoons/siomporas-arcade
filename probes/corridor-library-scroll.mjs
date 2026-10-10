// EVERY TAB OF THE ASSET LIBRARY SCROLLS, on both pages that mount it.
//
// Rich, 2026-10-10: "Materials and fixtures don't scroll." The day before it was Sounds ("That
// doesn't scroll"), and the day before that Vehicles and Materials in the dialog. Each one was
// fixed on its own, the next tab broke the same way, and nothing noticed — because the bug is not
// in any one tab. The library is a chain of boxes (the pane, the tab body, the panel, the tab's own
// columns) and a single content-sized box anywhere in it lets everything below grow past the pane
// instead of scrolling inside it. `.asset-pane .tab-panel { overflow: hidden }` then clips what
// grew, and a clipped list looks exactly like a short one.
//
// So this does not ask any tab whether it "has a scroller". It measures GEOMETRY, tab by tab, in
// world.html (the library is the pane) and editor.html (the library is a dialog):
//
//   1. something in the tab is taller than the pane — the case worth testing. A short window
//      (640 px) makes that true of nearly every tab; one that still fits is tried again at 420.
//   2. NOTHING IS STRANDED: every element that ends below the pane's bottom edge has a scroll
//      container between it and the pane whose own box is inside the pane. Content below the
//      edge with no such ancestor is content nobody can reach — the bug, measured.
//   3. every overflowing scroller TAKES a scrollTop — set it, read it back.
//   4. one panel at a time: a `display` rule on a panel beats `[hidden]` (buildscreen.css), so the
//      rendered height of the other panels is asserted, not the attribute.
//
// And it proves it can fail: with the panel chain broken on purpose (the way it was before the fix:
// a content-sized panel), the same measurement has to report stranded content.
//
//   PORT=5196 WORLD=crofton-triangle node probes/corridor-library-scroll.mjs
//   (needs WORLDEDITOR=… on the dev server for world.html — see tools/worldeditor/README.md)
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const WORLD = process.env.WORLD ?? 'crofton-triangle'
const ONLY = process.env.ONLY ?? '' // 'world' or 'editor' to run one page
const base = `http://127.0.0.1:${PORT}`

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

/** The measurement, in the page. `paneSel` is the box the library owns on screen. */
function measure(paneSel) {
  const pane = document.querySelector(paneSel)
  if (!pane) return { error: `no ${paneSel}` }
  const pr = pane.getBoundingClientRect()
  const bottom = Math.min(pr.bottom, innerHeight)
  const panels = [...pane.querySelectorAll('.tab-panel')]
  const shown = panels.filter((p) => p.getBoundingClientRect().height > 0)
  const panel = panels.find((p) => !p.hidden)
  if (!panel) return { error: 'no visible panel' }
  const scrolls = (n) => { const s = getComputedStyle(n); return s.overflowY === 'auto' || s.overflowY === 'scroll' }
  const describe = (n) => `${n.tagName.toLowerCase()}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`
  // every scroll container from the panel's content up to the pane that has more than it shows
  const scrollers = []
  for (const n of [panel, ...panel.querySelectorAll('*'), ...(() => { const up = []; for (let a = panel.parentElement; a && a !== pane.parentElement; a = a.parentElement) up.push(a); return up })()]) {
    if (!(n instanceof HTMLElement) || !scrolls(n)) continue
    const r = n.getBoundingClientRect()
    if (r.height <= 0) continue
    if (n.scrollHeight > n.clientHeight + 4) scrollers.push(n)
  }
  // stranded: below the pane's edge with no scroller (inside the pane) between it and the pane
  const stranded = []
  let below = 0
  for (const n of panel.querySelectorAll('*')) {
    const r = n.getBoundingClientRect()
    if (r.height <= 0 || r.width <= 0) continue
    if (r.bottom <= bottom + 2) continue
    if (n.children.length && !(n instanceof HTMLButtonElement)) continue // leaves (and buttons) only: a box is its contents
    below++
    let reach = false
    for (let a = n.parentElement; a && a !== pane.parentElement; a = a.parentElement) {
      if (scrolls(a) && a.getBoundingClientRect().bottom <= bottom + 2 && a.scrollHeight > a.clientHeight + 1) { reach = true; break }
    }
    if (!reach) stranded.push(`${describe(n)} "${(n.textContent ?? '').trim().slice(0, 30)}" at ${Math.round(r.bottom)}px`)
  }
  // and it TAKES: each overflowing scroller, scrolled to the end and read back
  const took = scrollers.map((s) => {
    const before = s.scrollTop
    s.scrollTop = s.scrollHeight
    const after = s.scrollTop
    s.scrollTop = before
    return { what: describe(s), h: s.clientHeight, content: s.scrollHeight, moved: after > before, inPane: s.getBoundingClientRect().bottom <= bottom + 2 }
  })
  return { paneH: Math.round(bottom - pr.top), shown: shown.length, below, stranded: stranded.slice(0, 4), strandedN: stranded.length, took, children: panel.querySelectorAll('*').length }
}

async function sweep(page, label, paneSel) {
  const tabs = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} .tab-strip .tab`)].map((b) => b.textContent.trim()), paneSel)
  ok(`${label}: the library has its tabs`, tabs.length >= 8, tabs.join(', '))
  for (const t of tabs) {
    await page.setViewportSize({ width: 1280, height: 640 })
    await page.evaluate(([sel, name]) => [...document.querySelectorAll(`${sel} .tab-strip .tab`)].find((b) => b.textContent.trim() === name)?.click(), [paneSel, t])
    // a tab builds once, and most of them fetch: wait until the panel stops changing
    let last = -1
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(400)
      const n = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} .tab-panel`)].find((p) => !p.hidden)?.querySelectorAll('*').length ?? 0, paneSel)
      if (n > 0 && n === last) break
      last = n
    }
    let m = await page.evaluate(measure, paneSel)
    if (m.error) { ok(`${label} · ${t}`, false, m.error); continue }
    let tall = m.took.length > 0 || m.below > 0
    if (!tall) {
      await page.setViewportSize({ width: 1280, height: 420 })
      await page.waitForTimeout(500)
      m = await page.evaluate(measure, paneSel)
      tall = m.took.length > 0 || m.below > 0
    }
    ok(`${label} · ${t}: one panel rendered`, m.shown === 1, `${m.shown} panels with height`)
    if (!tall) { console.log(`      ${label} · ${t}: fits a ${m.paneH} px pane with nothing to scroll (${m.children} elements)`); continue }
    ok(`${label} · ${t}: nothing below the pane's edge is out of reach`, m.strandedN === 0,
      m.strandedN ? `${m.strandedN} stranded, e.g. ${m.stranded.join('; ')}` : `${m.below} element(s) below the edge, all inside a scroller (pane ${m.paneH} px)`)
    const bad = m.took.filter((s) => s.inPane && !s.moved)
    ok(`${label} · ${t}: every overflowing scroller takes a scrollTop`, m.took.some((s) => s.moved) && bad.length === 0,
      m.took.map((s) => `${s.what} ${s.h}/${s.content}px${s.moved ? ' moved' : ' STUCK'}`).join(', ') || 'no scroller at all')
  }
}

/** The broken chain, put back on purpose: the panel sized to its content again. */
async function provable(page, label, paneSel, tab) {
  await page.setViewportSize({ width: 1280, height: 640 })
  await page.evaluate(([sel, name]) => [...document.querySelectorAll(`${sel} .tab-strip .tab`)].find((b) => b.textContent.trim() === name)?.click(), [paneSel, tab])
  await page.waitForTimeout(1200)
  const style = await page.addStyleTag({ content: `${paneSel} .tab-body, ${paneSel} .tab-panel, ${paneSel} .tab-panel * { overflow: visible !important; max-height: none !important; }` })
  await page.waitForTimeout(300)
  const m = await page.evaluate(measure, paneSel)
  await style.evaluate((n) => n.remove())
  ok(`${label}: with the scrollers defeated, ${tab} reports stranded content (the check can fail)`, m.strandedN > 0, `${m.strandedN} stranded`)
}

if (ONLY !== 'editor') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } })
  page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
  await page.goto(`${base}/world.html?world=${WORLD}#${WORLD}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => window.__we?.ready?.() === true, null, { timeout: 90000 })
  await page.evaluate(() => window.__we.setMode('assets'))
  await page.waitForSelector('#assets .tab-strip .tab', { timeout: 30000 })
  await sweep(page, 'world.html', '#assets')
  await provable(page, 'world.html', '#assets', 'Sounds')
  await page.close()
}

if (ONLY !== 'world') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 } })
  page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
  await page.goto(`${base}/editor.html#${WORLD}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction(() => !!window.__apexEditorAssets && !!window.__ed?.site, null, { timeout: 180000 })
  await page.evaluate(() => window.__apexEditorAssets())
  await page.waitForSelector('.dialog .asset-body .tab-strip .tab', { timeout: 30000 })
  await sweep(page, 'editor.html', '.dialog .asset-body')
  await provable(page, 'editor.html', '.dialog .asset-body', 'Sounds')
  await page.close()
}

await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: every library tab scrolls, on both pages')
process.exit(fails.length ? 1 : 0)
