// Settings → OSM data: does the dialog show which Overpass each world reads, and the ground the old
// fences would have baked as empty?
//
// Rich, 2026-10-10: "Can we add a facility to the world editor, maybe a dialogue spawned from the
// settings menu, where we can see OSM coverage and select and download more source OSM data?"
//
// Run against a worldeditor whose Overpass list is the cluster's three instances (port-forwards,
// named `overpass-eu=…,overpass=…,overpass-na=…`) and whose worlds are the deployed editor's:
//
//   MODE=before  the URLs still carry the old #s/w/n/e fences. dc-metro-take-2 must be flagged
//                MISROUTED — the fences send it to `overpass`, whose Maryland extract leaves a third
//                of it out — and the map must paint that missing ground red.
//   MODE=after   no fences. dc-metro-take-2 must be served by overpass-na and nothing painted red.
//
//   PORT=5205 MODE=before OUT=/path/shot.png node probes/worldedit-osmdata.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5205'
const MODE = process.env.MODE ?? 'after'
const OUT = process.env.OUT ?? `/tmp/osmdata-${MODE}.png`
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message); console.log('pageerror', e.message.slice(0, 160)) })
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__we?.ready?.() === true, null, { timeout: 90000 })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

// the way a person gets there: the menu, then OSM data
await page.click('button[title="menu"]')
await page.getByText('OSM data', { exact: true }).first().click()
await page.waitForFunction(() => {
  const d = window.__osmData
  return d && d.upstreams.length && d.health.size === d.upstreams.length && d.regions.length > 100
}, null, { timeout: 60000 })
await page.waitForTimeout(800)

const s = await page.evaluate(() => {
  const d = window.__osmData
  const rows = [...document.querySelectorAll('.osm-world')].map((r) => ({ slug: r.querySelector('.osm-world-slug')?.textContent, kind: [...r.classList].find((c) => c !== 'osm-world'), why: r.querySelector('.osm-world-why')?.textContent }))
  return {
    upstreams: d.upstreams.map((u) => `${u.name}:${u.regions.map((r) => r.id).join('+')}`),
    health: [...d.health.values()].map((h) => `${h.name}:${h.ok ? 'up' : 'DOWN'}:${h.timestamp}`),
    painted: d.map.painted,
    rows,
  }
})
console.log(JSON.stringify(s, null, 1))
const dc = s.rows.find((r) => r.slug === 'dc-metro-take-2')
ok('three instances, each outlined by its Geofabrik region', s.upstreams.length === 3 && s.painted.upstreams === 3, s.upstreams.join(', '))
ok('every instance answered and reported its replication timestamp', s.health.every((h) => /:up:\d{4}-/.test(h)), s.health.join(', '))
ok('dc-metro-take-2 is listed', !!dc, dc ? dc.why : 'missing')
if (MODE === 'before') {
  ok('dc-metro-take-2 is flagged as misrouted by the fences', dc?.kind === 'misrouted' && /fences send it to overpass/.test(dc.why), `${dc?.kind}: ${dc?.why}`)
  ok('and the missing ground is painted', s.painted.missing >= 1, `${s.painted.missing} world(s) with ground the fences would bake empty`)
} else {
  ok('dc-metro-take-2 is served by overpass-na', dc?.kind === 'ok' && /^overpass-na/.test(dc.why), `${dc?.kind}: ${dc?.why}`)
  ok('nothing is painted as missing', s.painted.missing === 0, `${s.painted.missing}`)
}
await page.locator('.dialog.size-xl').screenshot({ path: OUT })
console.log(`shot ${OUT}`)

// the picker: search, pick, see the outline and the size
await page.fill('.osm-search', 'virginia')
await page.locator('.osm-results .osm-pick').first().click()
await page.waitForFunction(() => window.__osmData?.picked?.bytes > 0 && !!window.__osmData?.map.preview, null, { timeout: 30000 })
await page.waitForTimeout(500)
const picked = await page.evaluate(() => ({ id: window.__osmData.picked.id, bytes: window.__osmData.picked.bytes, held: window.__osmData.picked.held, button: [...document.querySelectorAll('.osm-picked button')].map((b) => b.textContent).find((t) => /Add to/.test(t)) }))
ok('a region is picked with its .pbf size', picked.id === 'us/virginia' && picked.bytes > 1e8, JSON.stringify(picked))
// North America already holds Virginia; the instance it borders is the Maryland one
ok('it says who already holds it, and offers the instance it borders', picked.held.includes('overpass-na') && picked.button === 'Add to overpass', `${picked.held} / ${picked.button}`)
const OUT2 = OUT.replace(/\.png$/, '-pick.png')
await page.locator('.dialog.size-xl').screenshot({ path: OUT2 })
console.log(`shot ${OUT2}`)

ok('no page errors', errors.length === 0, errors.join(' | ') || 'none')
await browser.close()
if (fails.length) {
  console.log(`\n${fails.length} FAILED`)
  process.exit(1)
}
console.log('\nall ok')
