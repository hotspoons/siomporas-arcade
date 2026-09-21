// Repro for "the car flies 56 m off a flat interstate": is site.groundAt continuous along the road?
//
//   node probes/corridor-groundstep.mjs [site] [s0] [s1]
//
// Car.tickGround sets  vy = (gh - ref) / dt  — the ground's vertical speed from ONE tick's change in
// sampled height — and launch() hands that vy straight to the ballistic flight. At 40 m/s a tick
// covers 0.33 m, so a step of h metres in the height field becomes vy = h·120 m/s and a jump of
// vy²/2g metres. This prints the biggest per-tick steps so the step can be named, not guessed at.
import { chromium } from 'playwright'
const site = process.argv[2] ?? 'sideling-i68'
const s0 = Number(process.argv[3] ?? 0)
const s1 = Number(process.argv[4] ?? 0) || null
const PORT = process.env.CORRIDOR_PORT ?? '5202'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?lite#${site}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 240000 })

console.log(JSON.stringify(await page.evaluate(({ s0, s1 }) => {
  const { site } = window.corridor
  const L = site.manifest.spine.length_m
  const a = s0, b = s1 ?? L
  const STEP = 40 / 120 // one tick at 40 m/s
  const out = { site: site.manifest.slug, range: [a, +b.toFixed(0)], step_m: +STEP.toFixed(3) }
  const jumps = []
  let prev = null, prevS = a
  for (let s = a; s < b; s += STEP) {
    const p = site.spineAt(s)
    const g = site.groundAt(p.pos.x, p.pos.z)
    if (prev != null && g != null) {
      const d = g - prev
      if (Math.abs(d) > 0.05) jumps.push({ s: +s.toFixed(1), dz: +d.toFixed(3), vy: +(d / (1 / 120)).toFixed(1) })
    }
    prev = g; prevS = s
  }
  jumps.sort((x, y) => Math.abs(y.dz) - Math.abs(x.dz))
  out.worst = jumps.slice(0, 15)
  out.steps_over_5cm = jumps.length
  out.samples = Math.round((b - a) / STEP)
  // what is at those stations?
  out.structures = site.manifest.structures.map((st) => ({ kind: st.kind, s_start: +st.s_start.toFixed(0), s_end: +st.s_end.toFixed(0) }))
  // Which layer is lying? The bake's own road profile (manifest.profile.road_z, from the lidar DTM
  // along the spine) beside what the viewer's groundAt returns. If the profile is smooth and
  // groundAt is not, the corridor strip built the bump; if both step, it is in the baked heights.
  const pr = site.manifest.profile
  if (pr) {
    const rows = []
    for (let i = 0; i < pr.s.length; i++) {
      const sv = pr.s[i]
      if (sv < a - 5 || sv > b + 5) continue
      const p = site.spineAt(sv)
      rows.push({ s: +sv.toFixed(0), profile_z: +pr.road_z[i].toFixed(2), groundAt: +(site.groundAt(p.pos.x, p.pos.z) ?? NaN).toFixed(2) })
    }
    out.profile_vs_ground = rows
    let worstP = 0, worstG = 0
    for (let i = 1; i < rows.length; i++) {
      worstP = Math.max(worstP, Math.abs(rows[i].profile_z - rows[i - 1].profile_z))
      worstG = Math.max(worstG, Math.abs(rows[i].groundAt - rows[i - 1].groundAt))
    }
    out.max_step_between_profile_stations = { profile_m: +worstP.toFixed(2), groundAt_m: +worstG.toFixed(2), spacing_m: rows.length > 1 ? rows[1].s - rows[0].s : null }
  }
  return out
}, { s0, s1 }), null, 1))
await browser.close()
