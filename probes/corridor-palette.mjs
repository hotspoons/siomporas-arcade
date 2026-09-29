// The Place palette: see what you are about to put down, and drag it in.
//
// Rich, 2026-09-28: "The place pallette - if you click something it should show a little preview at
// the top instead of the awful placements.json warning, and you should be able to click and drag
// either the preview or from the palette directly to the world preview."
//
// The frame warning is still there when it is true — a document authored in another frame really
// does put things in the wrong place — but it is no longer the first thing in the panel, and it is
// not the thing that is there when nothing is wrong.
//
//   node probes/corridor-palette.mjs [world-slug]
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const WORLD = process.argv[2] ?? 'crofton-triangle'
// `--disable-dev-shm-usage` is not optional in this container: /dev/shm is 64 MB, and a renderer
// that fills it dies as "Target crashed" with nothing else to go on.
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await page.goto(`http://localhost:${PORT}/world.html?world=${WORLD}#${WORLD}`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForSelector('.seg', { timeout: 30000 })

// THE SEG NAVIGATES. `world.html` hands off to the site editor, so a `waitForFunction` installed
// before the click is evaluating in a context that is about to be destroyed — it rejects with
// "Execution context was destroyed", and this probe used to catch that and call it a SKIP. It
// reported "would not open in Place" for a week while Place opened fine. Wait for the new document
// first, and let a real timeout be a failure rather than a shrug.
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle', timeout: 90000 }).catch(() => {}),
  page.click('.seg[data-value="place"]'),
])
const manifest = await page.evaluate(async (w) => (await fetch(`/sites/${w}/web/manifest.json`)).status, WORLD)
if (manifest === 404) { console.log(`\nSKIP: ${WORLD} has no baked site to place anything in`); await browser.close(); process.exit(0) }
await page.waitForFunction(() => !!window.corridor?.place, null, { timeout: 120000 })
await page.waitForTimeout(2500)
await page.evaluate(() => [...document.querySelectorAll('#se-rail button')].find((b) => /^place$/i.test(b.textContent.trim()))?.click())
await page.waitForTimeout(900)
// the panel has two tabs now: picking what to place, and adjusting what is placed
await page.evaluate(() => [...document.querySelectorAll('#se-inspector .place-tab')].find((b) => /Assets/.test(b.textContent))?.click())
await page.waitForTimeout(500)

/* ---- the palette, and a search for a long one ---- */
const chips = await page.locator('#se-inspector .chip').count()
say('assets in the palette', chips)
if (!chips) fail.push('the palette is empty')
if (chips > 12 && !(await page.locator('#se-inspector .palette-find input').count())) {
  fail.push('a palette this long has no search')
}

/* ---- clicking one shows it ---- */
await page.waitForTimeout(400)
const withModel = await page.evaluate(() => {
  const a = window.corridor.place.catalog.assets.find((x) => x.glb)
  return a ? { id: a.id, name: a.name } : null
})
say('an asset with a model', withModel)
if (!withModel) { console.log('\nSKIP: nothing in the catalog has a model to preview'); await browser.close(); process.exit(0) }

/*
 * DRIVEN THROUGH THE DOM, not through Playwright's click.
 *
 * Its actionability wait needs two settled animation frames, and this page is rendering a 3D
 * scene through swiftshader — so `click` and `fill` time out on controls that are visible,
 * enabled and on top. The events dispatched here are the ones the app listens for.
 */
await page.evaluate((name) => {
  const box = document.querySelector('#se-inspector .palette-find input')
  if (box) { box.value = name; box.dispatchEvent(new Event('input', { bubbles: true })) }
}, withModel.name)
await page.waitForTimeout(500)
const filtered = await page.locator('#se-inspector .chip').count()
say('after searching', filtered)
if (filtered !== 1) fail.push(`searching for one asset left ${filtered} chips`)
await page.evaluate(() => document.querySelector('#se-inspector .chip')?.click())
await page.waitForTimeout(900)

const preview = await page.evaluate(() => {
  const box = document.querySelector('#se-inspector .palette-preview')
  if (!box) return null
  const panel = document.getElementById('se-inspector')
  // the tab strip is first by design; the preview must be the first thing IN the Assets tab
  const first = [...(panel?.children ?? [])].find((n) => !n.classList.contains('place-tabs'))
  const pal = document.querySelector('#se-inspector .palette')
  return {
    first: first?.className,
    draggable: box.draggable,
    canvas: !!box.querySelector('canvas'),
    // pinned, and the list scrolls under it
    sticky: getComputedStyle(box).position,
    closable: !!box.querySelector('.palette-close'),
    paletteScrolls: pal ? getComputedStyle(pal).overflowY : null,
  }
})
say('preview', preview ?? 'none')
if (!preview) fail.push('clicking an asset showed no preview')
else {
  // AT THE TOP: the thing you are about to place matters more than a caveat about a document
  if (!String(preview.first).includes('palette-preview')) fail.push(`the first thing in the tab is ${preview.first}, not the preview`)
  if (!preview.canvas) fail.push('the preview has no viewer in it')
  if (!preview.draggable) fail.push('the preview cannot be dragged')
  if (preview.sticky !== 'sticky') fail.push('the preview scrolls away with the list')
  if (!preview.closable) fail.push('the preview cannot be closed')
  if (preview.paletteScrolls !== 'auto' && preview.paletteScrolls !== 'scroll') fail.push('the palette does not scroll under it')
}

const loaded = await page.waitForFunction(() => window.__paletteview?.size, null, { timeout: 60000 }).then(() => true).catch(() => false)
say('model loaded', loaded ? await page.evaluate(() => window.__paletteview.capture()) : 'never')
if (!loaded) fail.push('the preview never loaded the model')
else {
  const px = await page.evaluate(() => window.__paletteview.capture())
  if (px.max - px.min < 25) fail.push('the preview is an empty stage')
}

/* ---- and a chip drags straight into the world ---- */
const before = await page.evaluate(() => window.__apexPlace.count())
const drag = await page.evaluate(async (id) => {
  const chip = document.querySelector('#se-inspector .chip')
  const canvas = document.getElementById('gl')
  const dt = new DataTransfer()
  chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
  const carried = dt.getData('text/apex-asset')
  const r = canvas.getBoundingClientRect()
  for (const fy of [0.9, 0.85, 0.8]) {
    const start = window.__apexPlace.count()
    const at = { clientX: r.left + r.width * 0.5, clientY: r.top + r.height * fy, bubbles: true, cancelable: true, dataTransfer: dt }
    const over = new DragEvent('dragover', at)
    canvas.dispatchEvent(over)
    canvas.dispatchEvent(new DragEvent('drop', at))
    await new Promise((res) => setTimeout(res, 900))
    if (window.__apexPlace.count() > start) return { carried, prevented: over.defaultPrevented, last: window.__apexPlace.last() }
  }
  return { carried, prevented: false, last: null }
}, withModel.id)
say('dragged from the palette', drag)
if (!drag.carried) fail.push('a palette chip carries no asset id when dragged')
if (!drag.last) fail.push('dragging a chip onto the world placed nothing')
else if ((await page.evaluate(() => window.__apexPlace.count())) !== before + 1) fail.push('the drag placed the wrong number of things')

if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: the preview is at the top, and a chip drags straight into the world')
await browser.close()
process.exit(fail.length ? 1 : 0)
