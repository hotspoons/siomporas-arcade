// The world map's coastline, from OSM, past the overview zoom.
//
// Rich, 2026-09-30, over Maine: "No coast line unless you zoom way out." The only shore was Natural
// Earth's 1:110m country outline — one straight diagonal through Bar Harbor at zoom 8, faded out
// by zoom 9. The `coast` layer (tools/worldeditor/layers.mjs) is OSM's natural=coastline.
//
// ASSERTED ON WHAT WAS DRAWN, not on a request going out: coastline tiles have to come back with
// ways in them (a regional Overpass answers out of its area with an empty 200, which caches as a
// perfectly ordinary empty tile), and the painter has to have stroked some of them in view.
//
//   PORT=5187 node probes/corridor-coastline.mjs
//   BASE=https://worldeditor.richard-siomporas.basedweights.com node probes/corridor-coastline.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const BASE = process.env.BASE ?? `http://localhost:${PORT}`
// RESOLVE=host=ip pins a hostname, for checking a deploy while its DNS record is still settling
const RESOLVE = process.env.RESOLVE ? [`--host-resolver-rules=MAP ${process.env.RESOLVE.replace('=', ' ')}`] : []
const OUT = process.env.OUT ?? '/tmp'
const fail = []
const say = (k, v) => console.log(`${k.padEnd(30)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

const browser = await chromium.launch({ args: [...RESOLVE, '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
// 'load', not 'networkidle': the map streams tiles for as long as it is open
await page.goto(`${BASE}/world.html`, { waitUntil: 'load', timeout: 90000 })
await page.waitForFunction(() => window.__we?.ready(), null, { timeout: 90000 })

// THE VARIANT IS PART OF THE ASSERTION. The first cut of this passed at zoom 12 in 0.0 s, off the
// zoom-8 tile still held — the map drew every coast tile it had ever fetched, so a 300 m-simplified
// shore sat across the fine one. Each step waits for tiles of ITS variant and checks the painter
// drew nothing else.
for (const [name, lon, lat, zoom, variant] of [['Maine coast, zoom 8', -68.8, 44.2, 8, 'c'], ['Mount Desert Island, zoom 12', -68.30, 44.36, 12, 'f']]) {
  await page.evaluate(([lon, lat, zoom]) => window.__we.map.flyTo({ lon, lat }, zoom), [lon, lat, zoom])
  const t0 = Date.now()
  const got = await page.waitForFunction(([z, v]) => {
    const m = window.__we.map
    const all = [...m.tiles.values()].filter((t) => t.layer === 'coast')
    const mine = all.filter((t) => t.variant === v)
    if (Math.round(m.zoom) !== z || !mine.some((t) => t.items.length) || m.coastDrawn === 0) return null
    const mineWays = mine.reduce((a, t) => a + t.items.length, 0)
    return { tiles: mine.length, heldAll: all.length, ways: mineWays, drawnFrom: m.itemsOf('coast').length, inView: m.coastDrawn }
  }, [zoom, variant], { timeout: 120000 }).then((h) => h.jsonValue()).catch(() => null)
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)
  // the first tile of a variant is not the last: let the plan finish, paint once more, and read
  // the numbers off THAT paint, so "in view" and "held" describe the same frame
  await page.waitForTimeout(3000)
  const settled = got && (await page.evaluate(async (v) => {
    const m = window.__we.map
    m.draw() // schedules a frame; two rAFs later that frame has painted
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const mine = [...m.tiles.values()].filter((t) => t.layer === 'coast' && t.variant === v)
    return { tiles: mine.length, ways: mine.reduce((a, t) => a + t.items.length, 0), drawnFrom: m.itemsOf('coast').length, inView: m.coastDrawn }
  }, variant))
  say(name, settled ? { ...settled, firstTileAfter: `${seconds} s` } : 'NO COASTLINE')
  if (!settled) fail.push(`${name}: no coastline of variant ${variant} drawn`)
  else {
    if (settled.drawnFrom !== settled.ways) fail.push(`${name}: drew from ${settled.drawnFrom} ways but only ${settled.ways} are ${variant} — stale tiles are being drawn too`)
    if (settled.inView > settled.drawnFrom || settled.inView === 0) fail.push(`${name}: ${settled.inView} ways in view out of ${settled.drawnFrom}`)
  }
  await page.screenshot({ path: `${OUT}/coast-z${zoom}.png` })
}

if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: the coastline is drawn from OSM at zoom 8 and zoom 12')
await browser.close()
process.exit(fail.length ? 1 : 0)
