// Road geometry: what speed does the baked spine actually support, and does it have kinks?
//
//   node probes/corridor-geometry.mjs [site]
//
// Horizontal curvature κ = dθ/ds from the spine tangent, smoothed over a car length. A car holding
// the line needs lateral acceleration v²κ; with CAR_GRIP_LATERAL m/s² available the road's own speed
// limit is v_max = sqrt(grip / κ). A real interstate curve is 400 m radius and up (v_max > 90 m/s);
// anything under ~100 m radius on a motorway spine is a kink in the bake, not a corner.
// Also: paved half width from edgeDistance at the centreline, so "the lanes are too narrow" is a
// number and not an impression.
import { chromium } from 'playwright'
const site = process.argv[2] ?? 'bowie-racetrack-rd'
const PORT = process.env.CORRIDOR_PORT ?? '5202'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?lite#${site}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 240000 })

console.log(JSON.stringify(await page.evaluate(() => {
  const { site } = window.corridor
  const L = site.manifest.spine.length_m
  const STEP = 2
  const n = Math.floor(L / STEP)
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
  const th = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const d = site.spineAt(i * STEP).dir
    th[i] = Math.atan2(d.z, d.x)
  }
  // curvature over a 10 m base: dθ across ±5 m, which is the scale a 4.4 m car feels
  const W = 3 // ±6 m
  const rows = []
  for (let i = W; i < n - W; i++) {
    const k = Math.abs(wrap(th[i + W] - th[i - W])) / (2 * W * STEP)
    rows.push({ s: i * STEP, k })
  }
  const GRIP = 22
  const byK = [...rows].sort((a, b) => b.k - a.k)
  const merged = []
  for (const r of byK) {
    if (r.k < 1e-5) break
    if (merged.some((m) => Math.abs(m.s - r.s) < 40)) continue
    merged.push({ s: r.s, radius_m: +(1 / r.k).toFixed(0), v_max_mps: +Math.sqrt(GRIP / r.k).toFixed(1) })
    if (merged.length >= 10) break
  }
  // paved half width at the centreline, every 25 m
  const halves = []
  for (let s = 10; s < L - 10; s += 25) {
    const p = site.spineAt(s)
    // walk right until edgeDistance crosses zero
    let lo = 0, hi = 30
    for (let it = 0; it < 24; it++) {
      const mid = (lo + hi) / 2
      const x = p.pos.x - p.dir.z * mid, z = p.pos.z + p.dir.x * mid
      const e = site.edgeDistance(x, z)
      if (Number.isFinite(e) && e < 0) lo = mid; else hi = mid
    }
    halves.push(lo)
  }
  halves.sort((a, b) => a - b)
  const q = (p) => +(halves[Math.floor(halves.length * p)] ?? -1).toFixed(2)
  // Where the paint actually is: take the road group's marking mesh, keep the vertices within 2 m of
  // a station, and project them onto the spine's right vector. The lateral offsets ARE the line
  // positions — read off the geometry that renders, not recomputed from the same constants.
  const paintAt = (s) => {
    const p = site.spineAt(s)
    const rx = -p.dir.z, rz = p.dir.x
    const out = []
    site.layers.road.traverse((o) => {
      if (!o.isMesh || o.name !== 'road:markings') return
      const pos = o.geometry.getAttribute('position')
      const col = o.geometry.getAttribute('color')
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - p.pos.x, dz = pos.getZ(i) - p.pos.z
        const along = dx * p.dir.x + dz * p.dir.z
        if (Math.abs(along) > 2) continue
        const lateral = dx * rx + dz * rz
        const yellow = col ? col.getX(i) > 0.5 && col.getZ(i) < 0.4 : null
        out.push({ off: Math.round(lateral * 100) / 100, yellow })
      }
    })
    // cluster the offsets into lines
    out.sort((a, b) => a.off - b.off)
    const lines = []
    for (const v of out) {
      const last = lines[lines.length - 1]
      if (last && v.off - last.max < 0.35) { last.max = Math.max(last.max, v.off); last.n++; last.yellow ||= v.yellow }
      else lines.push({ min: v.off, max: v.off, n: 1, yellow: v.yellow })
    }
    return lines.filter((l) => l.n >= 3).map((l) => ({ centre_m: +((l.min + l.max) / 2).toFixed(2), width_m: +(l.max - l.min).toFixed(2), colour: l.yellow ? 'yellow' : 'white' }))
  }
  const marks = { }
  for (const s of [site.manifest.spine.photo_s, 300, 1200, 2400]) {
    if (s > L - 20) continue
    marks[`s=${Math.round(s)}`] = { lanes: Number(site.manifest.spine.segments.find((g) => s >= g.s_start && s < g.s_end)?.tags.lanes) || null, lines: paintAt(s) }
  }

  return {
    site: site.manifest.slug,
    paint: marks,
    length_m: +L.toFixed(0),
    tightest: merged,
    centreline_edgeDistance: +site.edgeDistance(site.spineAt(site.manifest.spine.photo_s).pos.x, site.spineAt(site.manifest.spine.photo_s).pos.z).toFixed(2),
    paved_half_m: { min: q(0), p25: q(0.25), median: q(0.5), p75: q(0.75), max: +(halves.at(-1) ?? -1).toFixed(2) },
    lanes: site.manifest.spine.segments.map((sg) => ({ s: [+sg.s_start.toFixed(0), +sg.s_end.toFixed(0)], lanes: sg.tags.lanes, oneway: sg.tags.oneway, hw: sg.tags.highway, turn: sg.tags['turn:lanes'] })).slice(0, 40),
  }
}), null, 1))
await browser.close()
