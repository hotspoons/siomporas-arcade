// What the building classes' facades cost, on a big world, against the same view without them.
//
// Rich asked for the draw-call and memory cost to be measured on dc-metro-take-2 (63 km of Beltway,
// 446,193 footprints in 1,356 tiles), so this loads it twice — BUILDING_FACADES 1, then 0, the knob set the way a
// browser keeps it — stands at the same place, lets the building tiles stream in, and reads the
// renderer: draw calls, programs, textures, the massing geometry's bytes, the facade array's bytes,
// and the JS heap. Then, with the facades on, it frames the tallest building in view and draws it
// with its class's reflectiveness and again with the reflectiveness turned off, as two pictures and
// as a pixel difference — the check that the reflection is really drawn and can fail.
//
//   PORT=5196 WORLD=dc-metro-take-2 XY=7760,10130 OUT=/tmp/shots node probes/corridor-facades-cost.mjs
//   (dc-metro lives on the cluster: run the dev server with WORLDEDITOR_REMOTE — `just corridor-remote`)
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const PORT = process.env.PORT ?? '5185'
const WORLD = process.env.WORLD ?? 'dc-metro-take-2'
const LON = Number(process.env.LON ?? -77.2228) // Tysons, where the Beltway passes the towers
const LAT = Number(process.env.LAT ?? 38.9187)
/** or site metres directly — dc-metro's towers are densest in its 1 km tile (7, 10): 76 over 40 m */
const XY = process.env.XY ? process.env.XY.split(',').map(Number) : null
const OUT = process.env.OUT ?? '/tmp'
const SETTLE_S = Number(process.env.SETTLE_S ?? 240)

async function visit(facades) {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=8192', '--enable-precise-memory-info'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))
  // the knob as the F6 panel keeps it, before the page reads it
  await page.addInitScript((on) => { try { localStorage.setItem('apex-corridor-world.tune.v1', JSON.stringify({ v: 2, values: { BUILDING_FACADES: on }, touched: ['BUILDING_FACADES'] })) } catch { /* */ } }, facades)
  await page.goto(`http://127.0.0.1:${PORT}/?ui=dev#${WORLD}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, WORLD, { timeout: 600000 })
  // the level places the car after the site loads: wait for it, or the drop below is undone
  await page.waitForFunction(() => !!window.corridor.car, null, { timeout: 300000 }).catch(() => {})
  await page.waitForTimeout(8000)
  const at = await page.evaluate(([lon, lat, xy]) => {
    const c = window.corridor
    const L = c.site.layers
    if (L.trees) L.trees.visible = false
    if (L.grass) L.grass.visible = false
    c.tune.set('TIME_RATE', 0)
    c.time?.setLocal?.('2026-06-21', '16:30')
    const [x, y] = xy ?? c.project(lon, lat)
    // THE CAR, not the camera: the builders rank their work by a focus ahead of the car
    // (PERF-RIG.md), so a camera flown to Tysons with the car left at the start streams the start
    const dropped = c.chrome.teleport(x, y)
    return { x, y, dropped }
  }, [LON, LAT, XY])
  await page.waitForTimeout(3000)
  // where the car really is now (world x, -z is site y): the measurement is only worth anything there
  at.car = await page.evaluate(() => { const p = window.corridor.car?.pos ?? window.corridor.car?.position; return p ? [Math.round(p.x), Math.round(-p.z)] : null })
  // let the tiles near the eye stream and build: the pump does the ground and the roads first and
  // the buildings after, so "the massing stopped changing" is not "done" — the pump says when
  // nothing near the eye is left (site.graded().pendingNear), and the massing has stopped too
  let last = -1, still = 0
  const t0 = Date.now()
  while ((Date.now() - t0) / 1000 < SETTLE_S && still < 16) {
    await page.waitForTimeout(2000)
    const s = await page.evaluate(() => { let v = 0; window.corridor.scene.traverse((o) => { if (o.name === 'buildings:massing') v += o.geometry.getAttribute('position').count }); return { v, pending: window.corridor.site.graded?.().pendingNear ?? 0 } })
    if (s.v > 0 && s.v === last && s.pending === 0) still += 2
    else still = 0
    last = s.v
  }
  // out of the car, so the camera is ours to place; the focus stays where the car is
  if (await page.evaluate(() => !!window.corridor.drive?.on)) await page.keyboard.press('Tab')
  await page.waitForTimeout(1500)
  await page.evaluate(([x, y]) => {
    const c = window.corridor
    const gy = c.site.groundAt(x, -y) ?? 0
    c.camera.position.set(x + 120, gy + 60, -y + 120)
    c.orbit.target.set(x, gy + 20, -y)
    c.orbit.update()
  }, [at.x, at.y])
  await page.waitForTimeout(3000)
  const m = await page.evaluate(() => {
    const c = window.corridor
    c.renderer.info.reset?.()
    c.renderer.render(c.scene, c.camera)
    const info = c.renderer.info
    let cells = 0, verts = 0, bytes = 0, mats = new Set()
    c.scene.traverse((o) => {
      if (o.name !== 'buildings:massing') return
      cells++
      mats.add(o.material.uuid)
      const g = o.geometry
      verts += g.getAttribute('position').count
      for (const a of Object.values(g.attributes)) bytes += a.array.byteLength
      if (g.index) bytes += g.index.array.byteLength
    })
    const f = c.site.facades()
    const t = c.site.buildingsTiming?.() ?? null
    return {
      calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? null,
      textures: info.memory.textures, geometries: info.memory.geometries,
      massingCells: cells, massingMaterials: mats.size, massingVerts: verts, massingBytes: bytes,
      facades: f ? f.stats() : null,
      footprintsLoaded: (c.site.manifest.buildings ?? []).length,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
      buildTiming: t ? { calls: t.calls, footprints: t.footprints, massMs: Math.round(t.massMs), dressMs: Math.round(t.dressMs) } : null,
    }
  })
  let shots = null
  if (facades) shots = await towerShots(page)
  const mode = await page.evaluate(() => (window.corridor.drive?.on ? 'drive' : 'fly')).catch(() => '?')
  await browser.close()
  return { knob: facades, at, mode, settledAfterS: Math.round((Date.now() - t0) / 1000), ...m, shots, errors }
}

/** The tallest loaded building, framed; drawn with its class's reflectiveness and without it. */
async function towerShots(page) {
  const tower = await page.evaluate(() => {
    const c = window.corridor, f = c.site.facades()
    const cam = c.camera.position
    let best = null
    for (const b of c.site.manifest.buildings ?? []) {
      let x = 0, y = 0
      for (const p of b.ring) { x += p[0]; y += p[1] }
      x /= b.ring.length; y /= b.ring.length
      if ((x - cam.x) ** 2 + (-y - cam.z) ** 2 > 2000 ** 2) continue
      if (!best || b.height_m > best.h) best = { x, y, h: b.height_m, area: b.area_m2, cls: f?.plan.classes[f.slotOf(b)]?.id ?? null, tags: b.tags }
    }
    if (!best) return null
    const gy = c.site.groundAt(best.x, -best.y) ?? 0
    const r = Math.max(60, best.h * 1.6)
    // low and off the diagonal, so the walls face the sky the camera sees reflected
    c.camera.position.set(best.x + r * 0.8, gy + Math.max(8, best.h * 0.35), -best.y + r * 0.6)
    c.orbit.target.set(best.x, gy + best.h * 0.55, -best.y)
    c.orbit.update()
    return best
  })
  if (!tower) return null
  await page.waitForTimeout(8000)
  const on = `${OUT}/facades-tower-reflect-on.png`
  await page.screenshot({ path: on, timeout: 300000 })
  const sample = () => page.evaluate(() => {
    const c = window.corridor
    c.renderer.render(c.scene, c.camera)
    const gl = c.renderer.getContext()
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return Array.from(px.filter((_, i) => i % 64 === 0))
  })
  const a = await sample()
  const surface = await page.evaluate((cls) => { const f = window.corridor.site.facades(); const c = f.classes.find((x) => x.id === cls); f.setSurface(cls, { metalness: 0, roughness: 0.9 }); return { metalness: c.metalness, roughness: c.roughness } }, tower.cls)
  await page.waitForTimeout(1500)
  const b = await sample()
  const off = `${OUT}/facades-tower-reflect-off.png`
  await page.screenshot({ path: off, timeout: 300000 })
  let diff = 0
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
  return { tower, classSurface: surface, on, off, meanAbsDiff: +(diff / a.length).toFixed(3) }
}

const runs = []
for (const f of (process.env.ONLY ? [Number(process.env.ONLY)] : [1, 0])) {
  const r = await visit(f)
  console.log(JSON.stringify(r, null, 1))
  runs.push(r)
}
writeFileSync(`${OUT}/facades-cost-${WORLD}.json`, JSON.stringify(runs, null, 1))
const on = runs.find((r) => r.knob === 1), off = runs.find((r) => r.knob === 0)
if (on && off) {
  console.log(`\n${WORLD}: facades on vs off at the same place`)
  console.log(`  draw calls        ${on.calls} vs ${off.calls}`)
  console.log(`  programs          ${on.programs} vs ${off.programs}`)
  console.log(`  textures          ${on.textures} vs ${off.textures}`)
  console.log(`  massing cells     ${on.massingCells} (${on.massingMaterials} materials) vs ${off.massingCells}`)
  console.log(`  massing geometry  ${(on.massingBytes / 1e6).toFixed(1)} MB vs ${(off.massingBytes / 1e6).toFixed(1)} MB for ${on.massingVerts} vs ${off.massingVerts} vertices`)
  console.log(`  facade array      ${on.facades ? `${on.facades.layers} layers at ${on.facades.px}², ${(on.facades.atlasBytes / 1e6).toFixed(1)} MB` : 'none'}`)
  console.log(`  JS heap           ${on.heapMB} MB vs ${off.heapMB} MB`)
  if (on.shots) console.log(`  reflection        ${on.shots.tower.cls} ${on.shots.tower.h} m: mean |Δ| ${on.shots.meanAbsDiff} with it off`)
}
