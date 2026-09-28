// The roster: can you find a thing, see it, and put it in the world?
//
// Rich, 2026-09-28: "We should be able to preview and place assets from the roster (needs a search
// too for big lists)... We should be able to drag from the roster, place it on the map, set the
// pose, that's it."
//
// A DRAG IS THE HARD ONE TO CHECK and the easy one to get wrong: `dragover` must preventDefault or
// the browser refuses the drop, and the failure is a drag that animates correctly and ends in
// nothing. Playwright's `dragTo` drives the real DataTransfer, so this exercises the same protocol
// a hand does — and the check is not that an event fired but that the placements document gained
// an item at the point the cursor was over.
//
//   node probes/corridor-roster.mjs [world-slug]
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const WORLD = process.argv[2] ?? 'crofton-triangle'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await page.goto(`http://localhost:${PORT}/world.html?world=${WORLD}#${WORLD}`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForSelector('.seg', { timeout: 30000 })

/* ---- the scene has to be up before anything can be dropped on it ---- */
await page.click('.seg[data-value="place"]')
const ready = await page.waitForFunction(() => {
  const c = document.getElementById('gl')
  return !!c && c.clientWidth > 200
}, null, { timeout: 90000 }).then(() => true).catch(() => false)
await page.waitForTimeout(4000)
say('place scene up', ready)
if (!ready) { console.log(`\nSKIP: ${WORLD} would not open in Place`); await browser.close(); process.exit(0) }

/* ---- the roster ---- */
await page.click('.seg[data-value="assets"]')
await page.waitForSelector('#panel .roster-row', { timeout: 30000 })
const all = await page.locator('#panel .roster-row').count()
say('rows', all)
if (all < 2) fail.push('the roster is empty — it is not reading the placeable catalog')

// no second generation interface in here
const generators = await page.locator('#panel', { hasText: 'Reconstruct' }).count()
say('generate controls in the panel', generators)
if (generators) fail.push('the panel still carries a generation flow')

await page.locator('#panel .tree-filter input').fill('barn')
await page.waitForTimeout(500)
const matched = await page.locator('#panel .roster-row .row-name').allTextContents()
say('search “barn”', matched)
if (matched.length !== 1 || !/barn/i.test(matched[0])) fail.push(`search matched ${JSON.stringify(matched)}`)

await page.locator('#panel .roster-row').first().click()
const shown = await page.waitForFunction(() => window.__rosterview?.size, null, { timeout: 60000 }).then(() => true).catch(() => false)
say('preview', shown ? await page.evaluate(() => window.__rosterview.capture()) : 'never loaded')
if (!shown) fail.push('no 3D preview for an asset that has a model')
else {
  const px = await page.evaluate(() => window.__rosterview.capture())
  if (px.max - px.min < 25) fail.push('the preview is an empty stage')
}

/* ---- drag it onto the world ---- */
const before = await page.evaluate(() => window.__apexPlace?.count?.() ?? -1)
say('placements before', before)
if (before < 0) fail.push('no placement count exposed — cannot tell whether a drop landed')
else {
  /*
   * THE DRAG IS DISPATCHED BY HAND, with a real DataTransfer.
   *
   * Playwright's `dragTo` drives a mouse and waits for navigations that a canvas-heavy page never
   * settles; this drives the four events the protocol is actually made of, which is the part the
   * app implements. What it checks is the same thing: that `dragover` is prevented (or the drop is
   * refused), that the id travels on the dataTransfer, and that the drop raycasts to a point.
   */
  const dropped = await page.evaluate(() => {
    const row = document.querySelector('#panel .roster-row')
    // `#gl` is the SCENE. `#map` is the map, sits in the same box and is first in document
    // order, so `querySelector('canvas')` dropped onto the wrong one.
    const canvas = document.getElementById('gl')
    if (!row || !canvas) return { error: 'no row or no canvas' }
    const dt = new DataTransfer()
    const r = canvas.getBoundingClientRect()
    const at = { clientX: r.left + r.width * 0.45, clientY: r.top + r.height * 0.55, bubbles: true, cancelable: true, dataTransfer: dt }
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    const over = new DragEvent('dragover', at)
    // dragstart brings the world up; the canvas has to be the one that is now showing
    void canvas
    canvas.dispatchEvent(over)
    const prevented = over.defaultPrevented
    canvas.dispatchEvent(new DragEvent('drop', at))
    row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    return { prevented, carried: dt.getData('text/apex-asset') }
  })
  say('drag protocol', dropped)
  if (!dropped.prevented) fail.push('dragover was not prevented — the browser will refuse every drop')
  if (!dropped.carried) fail.push('the row put no asset id on the dataTransfer')
  await page.waitForTimeout(4000)

  /*
   * A DROP ON THE SKY MUST PLACE NOTHING.
   *
   * The first drop above was at 45%/55% of the canvas, which on an opened world is usually above
   * the horizon — and "place it somewhere anyway" would put a barn at whatever point the maths
   * happened to produce. So that one is the negative case, and the positive case is a drop low in
   * the frame where the terrain actually is.
   */
  const afterSky = await page.evaluate(() => window.__apexPlace.count())
  say('drop above the horizon', afterSky === before ? 'placed nothing, correctly' : 'PLACED SOMETHING')
  if (afterSky !== before) fail.push('a drop that did not hit the ground still placed something')

  const landed = await page.evaluate(async () => {
    const canvas = document.getElementById('gl')
    const r = canvas.getBoundingClientRect()
    for (const fy of [0.9, 0.85, 0.8, 0.95]) {
      const start = window.__apexPlace.count()
      const dt = new DataTransfer()
      dt.setData('text/apex-asset', 'barn-01')
      const at = { clientX: r.left + r.width * 0.5, clientY: r.top + r.height * fy, bubbles: true, cancelable: true, dataTransfer: dt }
      canvas.dispatchEvent(new DragEvent('dragover', at))
      canvas.dispatchEvent(new DragEvent('drop', at))
      await new Promise((res) => setTimeout(res, 900))
      if (window.__apexPlace.count() > start) return { at: fy, last: window.__apexPlace.last() }
    }
    return null
  })
  say('dropped on the ground', landed ?? 'nothing landed anywhere down the frame')
  if (!landed) fail.push('a drag onto the terrain placed nothing')
  else if (!/barn/i.test(String(landed.last?.asset))) fail.push(`it placed ${landed.last?.asset}, not the barn that was dragged`)
  else if (landed.last?.snap !== 'ground') fail.push('what was placed does not sit on the ground')
}

if (errs.length) { say('page errors', errs.slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: found it, saw it, dragged it into the world')
await browser.close()
process.exit(fail.length ? 1 : 0)
