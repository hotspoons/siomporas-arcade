// Merge tapers: does an auxiliary lane open and close over a taper, or appear sideways in one quad?
//
//   node probes/corridor-taper.mjs [site]
//
// Clarksburg's OSM has `lanes=4, turn:lanes=|||merge_to_left` for 200 m between two `lanes=3`
// stretches — an auxiliary lane between interchanges. Measures the paved half width every 2 m
// through each lane change and reports how far it takes to travel, which IS the taper.
import { chromium } from 'playwright'
const site = process.argv[2] ?? 'clarksburg-i270'
const PORT = process.env.CORRIDOR_PORT ?? '5202'
const knobs = Object.fromEntries((process.env.CORRIDOR_KNOBS ?? '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split(':'); return [k, Number(v)] }))
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 800, height: 560 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?lite#${site}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 240000 })

console.log(JSON.stringify(await page.evaluate(async ({ knobs }) => {
  const c = window.corridor
  const keys = (c.tune ?? []).flatMap((t) => t.sections.flatMap((s) => s.keys))
  const applied = {}
  for (const [n, v] of Object.entries(knobs)) { const k = keys.find((q) => q.name === n); if (k) { k.set(v); applied[n] = v } }
  if (Object.keys(applied).length) { c.site.retune(); await new Promise((ok) => setTimeout(ok, 1500)) }
  const site = c.site
  const L = site.manifest.spine.length_m
  // paved half width by bisecting edgeDistance outward from the centreline
  const half = (s) => {
    const p = site.spineAt(s)
    let lo = 0, hi = 30
    for (let i = 0; i < 22; i++) {
      const m = (lo + hi) / 2
      const e = site.edgeDistance(p.pos.x - p.dir.z * m, p.pos.z + p.dir.x * m)
      if (Number.isFinite(e) && e < 0) lo = m; else hi = m
    }
    return lo
  }
  // OSM lane-count changes from the segments
  const segs = site.manifest.spine.segments
  const changes = []
  for (let i = 1; i < segs.length; i++) {
    const a = Number(segs[i - 1].tags.lanes), b = Number(segs[i].tags.lanes)
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) changes.push({ s: segs[i].s_start, from: a, to: b, turn: segs[i].tags['turn:lanes'] ?? segs[i - 1].tags['turn:lanes'] ?? null })
  }
  const out = []
  for (const ch of changes.slice(0, 8)) {
    const w = []
    for (let d = -70; d <= 70; d += 2) { const s = ch.s + d; if (s > 0 && s < L) w.push([d, +half(s).toFixed(2)]) }
    const lo = Math.min(...w.map((q) => q[1])), hi = Math.max(...w.map((q) => q[1]))
    // how long the width takes to go from 10% to 90% of its travel: the taper
    const band = w.filter((q) => q[1] > lo + (hi - lo) * 0.1 && q[1] < hi - (hi - lo) * 0.1).map((q) => q[0])
    out.push({
      s: +ch.s.toFixed(0), lanes: `${ch.from}->${ch.to}`, turn: ch.turn,
      half_min_m: +lo.toFixed(2), half_max_m: +hi.toFixed(2), travel_m: +(hi - lo).toFixed(2),
      taper_m: band.length ? +(Math.max(...band) - Math.min(...band) + 2).toFixed(0) : 0,
    })
  }
  return { site: site.manifest.slug, ROAD_TAPER_M: keys.find((q) => q.name === 'ROAD_TAPER_M')?.get(), applied, changes: out }
}, { knobs }), null, 1))
await browser.close()
