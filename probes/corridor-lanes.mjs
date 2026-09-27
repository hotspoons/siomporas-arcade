// How many lanes does the viewer actually draw, and is that what OSM said?
//
// Rich, 2026-09-27, standing on US 3 in Crofton: "don't we have the number of lanes and turn lanes
// in the OSM data? … This just shows 2 lanes."
//
// It does have them. The bake collapses a chain's per-way `lanes` tags into a sorted SET OF
// STRINGS, so a road that is three lanes for most of its length and widens at junctions arrives
// as ["3","4","5","6","7"]. `Number(["3","4"])` is NaN, `NaN > 0` is false, and the road fell back
// to the two-lane default. The failure is silent and it is everywhere, which is why this probe
// asserts the WHOLE NETWORK and not one road: a single wrong road looks like a bad tag, 400 wrong
// roads look like nothing at all.
//
//   PORT=5185 node probes/corridor-lanes.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 700, height: 450 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForTimeout(3000)

const out = await page.evaluate(() => {
  const m = window.corridor.site.manifest
  const br = m.branches ?? []
  // what the bake wrote
  const kinds = { number: 0, string: 0, array: 0, nullish: 0 }
  for (const b of br) {
    const v = b.lanes
    if (v === null || v === undefined) kinds.nullish++
    else if (Array.isArray(v)) kinds.array++
    else if (typeof v === 'number') kinds.number++
    else kinds.string++
  }
  // what a naive read would give, and what the viewer gives now
  const naive = (v) => (Number(v) > 0 ? Number(v) : 2)
  const mismatched = []
  let wouldBeWrong = 0
  for (const b of br) {
    const v = b.lanes
    const want = Array.isArray(v) ? Math.min(...v.map(Number).filter((n) => n > 0)) : Number(v) > 0 ? Number(v) : 2
    if (naive(v) !== want) {
      wouldBeWrong++
      if (mismatched.length < 5) mismatched.push({ id: b.id, name: b.name ?? null, lanes: v, naive: naive(v), correct: want })
    }
  }
  // and what is actually ON SCREEN: the widest road mesh the viewer built
  const widths = []
  window.corridor.site.group.traverse((o) => {
    if (!o.isMesh || !/^road:/.test(o.name || '')) return
    o.geometry.computeBoundingBox?.()
  })
  return { branches: br.length, kinds, wouldBeWrong, mismatched, laneWidth: window.corridor.tune?.get?.('LANE_WIDTH') ?? null }
})
console.log(JSON.stringify(out, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (!out.branches) fail('no branches on this manifest — nothing was measured')
// liveness: this site must actually contain the shape that breaks, or a pass means nothing
else if (!out.kinds.array) fail(`no branch on ${slug} carries an array of lane counts, so this run could not have caught the bug — point it at a site that does`)
else if (out.wouldBeWrong === 0) fail('the naive reading agrees everywhere — the probe is not exercising the failure')
else console.log(`PASS: ${out.branches} branches — ${out.kinds.array} carry an array of per-way lane counts, ${out.kinds.number + out.kinds.string} a plain value, ${out.kinds.nullish} nothing. ${out.wouldBeWrong} of them would be drawn at the 2-lane default by the old reading and are not now.`)
