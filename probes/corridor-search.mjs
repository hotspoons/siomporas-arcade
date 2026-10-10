// Can you find an address in this world, and does picking it take you there?
//
// Rich, 2026-09-26: "We need an address search with autocomplete that pulls from the OSM data for
// a scene, and picking the address flies you to it."
//
// The index is built from the site's own osm.geojson, which the viewer already downloads. Two
// things have to be true and neither is obvious: the index must actually contain the site's
// addresses, and the COORDINATES must be right — osm.geojson is WGS84 and the world is ENU metres
// about the frame anchor, so a projection slip puts every result in the wrong place while the
// list still looks perfect.
//
//   PORT=5185 node probes/corridor-search.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForFunction(() => window.corridor.searchCounts?.().ready, null, { timeout: 120000 })

const out = await page.evaluate(() => {
  const c = window.corridor
  const counts = c.searchCounts()
  const bbox = c.site.manifest.bbox // [minE, minN, maxE, maxN] in plan metres
  // pick a real street out of the index itself rather than naming one I remember
  const anyRoad = c.search('road').find((h) => h.kind === 'road') ?? c.search('a').find((h) => h.kind === 'road')
  const anyAddr = c.search('1').find((h) => h.kind === 'address')
  const probeTerms = anyAddr ? anyAddr.label.split(/\s+/) : []
  // every result must land INSIDE the site, or the projection is wrong
  const sample = c.search(probeTerms[1] ?? 'road', 60)
  const inside = sample.filter((h) => h.x >= bbox[0] - 50 && h.x <= bbox[2] + 50 && -h.z >= bbox[1] - 50 && -h.z <= bbox[3] + 50)
  // two terms, either order, must find the same thing — that is what "autocomplete" has to mean
  const a = anyAddr ? c.search(anyAddr.label) : []
  const b = anyAddr ? c.search(anyAddr.label.split(/\s+/).reverse().join(' ')) : []
  return {
    counts, bbox,
    anyRoad, anyAddr,
    sampleN: sample.length,
    insideN: inside.length,
    outside: sample.filter((h) => !inside.includes(h)).slice(0, 3),
    bothOrdersAgree: !!(a[0] && b[0] && a[0].label === b[0].label),
    nonsense: c.search('zzzzqqq').length,
  }
})

// and the UI: type, see a list, pick the first, end up somewhere else
const ui = await page.evaluate(() => ({ before: [Math.round(window.corridor.camera.position.x), Math.round(window.corridor.camera.position.z)] }))
const box = await page.$('.search-input')
let typed = null
if (box) {
  await box.click()
  await page.keyboard.type(out.anyAddr ? out.anyAddr.label.slice(0, 9) : 'road', { delay: 15 })
  await page.waitForTimeout(400)
  typed = await page.evaluate(() => ({
    rows: document.querySelectorAll('.search-results .search-row').length,
    listShown: !document.querySelector('.search-results')?.hidden,
    // the list must not make the page scroll sideways
    docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
}
const after = await page.evaluate(() => [Math.round(window.corridor.camera.position.x), Math.round(window.corridor.camera.position.z)])
console.log(JSON.stringify({ ...out, ui: { ...ui, typed, after } }, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
const moved = Math.hypot(after[0] - ui.before[0], after[1] - ui.before[1])
if (!out.counts.ready) fail('the index never finished building')
else if (!(out.counts.address > 100)) fail(`only ${out.counts.address} addresses indexed — this site should have thousands`)
else if (!(out.counts.road > 10)) fail(`only ${out.counts.road} roads indexed`)
else if (!out.anyAddr) fail('searching for "1" found no address at all')
// the projection check: a result outside the site's own bbox means WGS84 was not projected
else if (!(out.insideN === out.sampleN)) fail(`${out.sampleN - out.insideN} of ${out.sampleN} results land outside the site bbox — the lon/lat was not projected into the world frame. e.g. ${JSON.stringify(out.outside[0])}`)
else if (!out.bothOrdersAgree) fail('the same words in a different order give a different first result — the match is order-dependent, which is not autocomplete')
else if (out.nonsense !== 0) fail(`a nonsense query returned ${out.nonsense} results — the filter is not filtering`)
else if (!box) fail('no search box in the top bar')
else if (!typed?.rows) fail('typing an address showed no results')
else if (typed.docOverflowX > 1) fail(`the result list pushes the page ${typed.docOverflowX}px sideways`)
else if (!(moved > 20)) fail(`picking a result moved the camera ${moved.toFixed(1)} m — it did not go anywhere`)
else console.log(`PASS: ${out.counts.address} addresses, ${out.counts.place} places, ${out.counts.road} roads; ${out.sampleN}/${out.sampleN} results inside the site; typing showed ${typed.rows} rows and picking one moved ${moved.toFixed(0)} m`)
