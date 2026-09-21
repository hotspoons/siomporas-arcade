// The blend band where the surface class changes: is it there, is it the width the knob says, and
// does it overlap anything (a transition strip that overlaps its neighbours z-fights).
//
//   node probes/corridor-blend.mjs [site] [out.png]
//
// Geometry first — the strips are their own meshes named road:blend:<from>><to>, so their extent
// along the road is measurable — then a top-down shot at the first class change for the eye.
import { chromium } from 'playwright'
const site = process.argv[2] ?? 'bowie-racetrack-rd'
const out = process.argv[3] ?? null
const PORT = process.env.CORRIDOR_PORT ?? '5202'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 760, height: 520 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
const shaderErrors = []
page.on('console', (m) => { const t = m.text(); if (/WebGLProgram|shader|GLSL/i.test(t)) shaderErrors.push(t.slice(0, 400)) })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?lite#${site}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 240000 })

const knobs = Object.fromEntries((process.env.CORRIDOR_KNOBS ?? '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split(':'); return [k, Number(v)] }))
const r = await page.evaluate(async ({ knobs }) => {
  const c = window.corridor
  const keys = (c.tune ?? []).flatMap((t) => t.sections.flatMap((s) => s.keys))
  const applied = {}
  for (const [n, v] of Object.entries(knobs)) { const k = keys.find((q) => q.name === n); if (k) { k.set(v); applied[n] = v } }
  if (Object.keys(applied).length) { c.site.retune(); await new Promise((ok) => setTimeout(ok, 1200)) }
  const blend = keys.find((q) => q.name === 'ROAD_BLEND_M')?.get()
  const strips = []
  const classMeshes = []
  c.site.layers.road.traverse((o) => {
    if (!o.isMesh) return
    if (o.name.startsWith('road:blend:')) {
      const p = o.geometry.getAttribute('position')
      // each strip is a quad: its length along the road is the distance between its two ends
      const quads = p.count / 4
      let minL = Infinity, maxL = 0
      for (let q = 0; q < quads; q++) {
        const i = q * 4
        const ax = (p.getX(i) + p.getX(i + 1)) / 2, az = (p.getZ(i) + p.getZ(i + 1)) / 2
        const bx = (p.getX(i + 2) + p.getX(i + 3)) / 2, bz = (p.getZ(i + 2) + p.getZ(i + 3)) / 2
        const d = Math.hypot(bx - ax, bz - az)
        minL = Math.min(minL, d); maxL = Math.max(maxL, d)
      }
      strips.push({ name: o.name, quads, len_min_m: +minL.toFixed(3), len_max_m: +maxL.toFixed(3), hasBlendAttr: !!o.geometry.getAttribute('blend') })
    } else if (o.name.startsWith('road:') && o.name !== 'road:markings') classMeshes.push(o.name)
  })
  // do the class meshes and the strips overlap? project every strip's centre onto the class meshes'
  // bounding boxes is too coarse — instead check the gap: the class geometry should stop short.
  const su = c.site.manifest.surface
  const changes = []
  if (su) for (let i = 1; i < su.segments.length; i++) if (su.segments[i].class !== su.segments[i - 1].class) changes.push(+su.segments[i].s_start.toFixed(0))
  return { site: c.site.manifest.slug, ROAD_BLEND_M: blend, applied, classMeshes, strips, class_changes: changes.length, first_changes: changes.slice(0, 6) }
}, { knobs })
console.log(JSON.stringify({ ...r, shaderErrors }, null, 1))

if (out && r.first_changes?.length) {
  // The camera is OrbitControls-driven, so parking camera.position alone lasts one frame. Go
  // through the app's own stance URL instead (?stance=<base64>), which sets the orbit target too.
  const s = r.first_changes[Math.min(1, r.first_changes.length - 1)]
  const st = await page.evaluate((s) => {
    const p = window.corridor.site.spineAt(s)
    const layers = {}
    for (const el of document.querySelectorAll('input[data-layer]')) layers[el.dataset.layer] = el.checked
    return {
      v: 1, site: window.corridor.site.manifest.slug, season: 'summer', mode: 'fly', lite: true, layers,
      // Oblique, not straight down: with the eye directly over the target the view's roll is
      // degenerate and two runs of the same stance come out rotated differently, which makes them
      // useless as a before/after pair. 9 m up, 16 m back along the road.
      cam: {
        p: [+(p.pos.x - p.dir.x * 16).toFixed(2), +(p.pos.y + 9).toFixed(2), +(p.pos.z - p.dir.z * 16).toFixed(2)],
        t: [+(p.pos.x + p.dir.x * 6).toFixed(2), +p.pos.y.toFixed(2), +(p.pos.z + p.dir.z * 6).toFixed(2)],
      },
    }
  }, s)
  const u = new URL(`http://127.0.0.1:${PORT}/`)
  u.searchParams.set('lite', '')
  u.searchParams.set('stance', Buffer.from(JSON.stringify(st)).toString('base64'))
  u.hash = st.site
  await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 180000 })
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 240000 })
  await page.evaluate(async (knobs) => {
    const keys = (window.corridor.tune ?? []).flatMap((t) => t.sections.flatMap((x) => x.keys))
    for (const [n, v] of Object.entries(knobs)) keys.find((q) => q.name === n)?.set(v)
    if (Object.keys(knobs).length) { window.corridor.site.retune(); await new Promise((ok) => setTimeout(ok, 1500)) }
  }, knobs)
  await page.waitForTimeout(3000)
  await page.screenshot({ path: out, timeout: 180000, animations: 'disabled' })
  console.log('shot', out, 'top-down at s =', s, 'blend', JSON.stringify(knobs))
}
await browser.close()
