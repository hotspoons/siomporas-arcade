// The building classes' facades, in the game: classed, pooled, picked per building, reflective.
//
// Rich, 2026-10-10: "random textures feed a single building type so we can get variety … glass ->
// skyscraper. Need to be able to assign reflectiveness for cases like skyscrapers." So this asks the
// running game, not the code: every loaded footprint is classed; a class draws more than one
// material from its pool (variety, measured from the vertex layers the massing actually wrote);
// every cell compiles to the one facade program; and a class's reflectiveness reaches the pixels —
// the same view drawn with the class mirror-smooth and matte must differ. Then it loads the world
// again with BUILDING_FACADES 0 and the same measurements must find nothing pooled (the checks can
// fail). That a building draws the same material on every build is test/facades.test.ts.
//
//   PORT=5196 WORLD=crofton-triangle SHOTS=/tmp/shots node probes/corridor-facades.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const WORLD = process.env.WORLD ?? 'crofton-triangle'
const SHOTS = process.env.SHOTS ?? ''
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message.slice(0, 200)); console.log('pageerror', e.message.slice(0, 200)) })
const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

await page.goto(`http://127.0.0.1:${PORT}/?ui=dev#${WORLD}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, WORLD, { timeout: 300000 })
// the swiftshader cliff: trees and grass off, or no frame arrives in time to measure anything
await page.evaluate(() => { const L = window.corridor.site.layers; if (L.trees) L.trees.visible = false; if (L.grass) L.grass.visible = false })
await page.waitForFunction(() => (window.corridor.site.manifest.buildings ?? []).length > 50, null, { timeout: 240000 })
// daylight, by longitude: the headless clock is UTC, so solar noon over Maryland is ~17:00 here
await page.evaluate(() => { const c = window.corridor; c.tune.set('TIME_RATE', 0); c.time?.setLocal?.('2026-06-21', '16:30') })

/** stand at a driver's-eye-and-a-bit, looking at (x, y) in site metres from `back` metres away */
const look = (x, y, back, up, lift) => page.evaluate(([x, y, back, up, lift]) => {
  const c = window.corridor
  const eye = { x: x + back * 0.8, z: -(y - back * 0.6) }
  const gy = c.site.groundAt(eye.x, eye.z) ?? 0
  c.camera.position.set(eye.x, gy + up, eye.z)
  c.orbit.target.set(x, (c.site.groundAt(x, -y) ?? gy) + lift, -y)
  c.orbit.update()
}, [x, y, back, up, lift])
/** the massing cells built so far */
const cells = () => page.evaluate(() => { let n = 0; window.corridor.scene.traverse((o) => { if (o.name === 'buildings:massing') n++ }); return n })

// a street of houses: the house with the most houses within 60 m
const street = await page.evaluate(() => {
  const c = window.corridor, f = c.site.facades()
  if (!f) return null
  const hs = (c.site.manifest.buildings ?? []).filter((b) => f.plan.classes[f.slotOf(b)]?.id === 'house')
  const cen = hs.map((b) => { let x = 0, y = 0; for (const p of b.ring) { x += p[0]; y += p[1] } return [x / b.ring.length, y / b.ring.length] })
  let best = 0, bi = 0
  for (let i = 0; i < cen.length; i += Math.max(1, Math.floor(cen.length / 400))) {
    let n = 0
    for (const q of cen) if ((q[0] - cen[i][0]) ** 2 + (q[1] - cen[i][1]) ** 2 < 3600) n++
    if (n > best) { best = n; bi = i }
  }
  return cen.length ? { x: cen[bi][0], y: cen[bi][1], houses: best } : null
})
console.log('street', JSON.stringify(street))
if (street) await look(street.x, street.y, 30, 7, 3)
for (let i = 0; i < 120 && (await cells()) === 0; i++) await page.waitForTimeout(2000)
await page.waitForTimeout(5000)

const facts = await page.evaluate(async () => {
  const c = window.corridor
  const f = c.site.facades()
  if (!f) return { none: true }
  const st = f.stats()
  // the massing the cells built: its vertex layers ARE what got drawn
  const meshes = []
  c.scene.traverse((o) => { if (o.name === 'buildings:massing') meshes.push(o) })
  const used = new Map()
  let textured = 0, total = 0
  for (const m of meshes) {
    const lay = m.geometry.getAttribute('layer')?.array ?? []
    total += lay.length
    for (const v of lay) if (v >= 0) { textured++; const s = Math.floor(v / 64), L = Math.round(v - s * 64); const k = `${f.plan.classes[s]?.id}:${f.plan.layers[L]}`; used.set(k, (used.get(k) ?? 0) + 1) }
  }
  const byClass = {}
  for (const b of c.site.manifest.buildings ?? []) { const s = f.slotOf(b); const id = f.plan.classes[s]?.id ?? 'none'; byClass[id] = (byClass[id] ?? 0) + 1 }
  const perClass = {}
  for (const k of used.keys()) { const [cls, mat] = k.split(':'); (perClass[cls] ??= []).push(mat) }
  const programs = new Set(meshes.map((m) => m.material.customProgramCacheKey?.() ?? 'plain'))
  const maps = new Set(meshes.map((m) => m.material.userData?.facadeMap ?? null))
  return { st, cells: meshes.length, textured, total, byClass, perClass, programs: [...programs], maps: maps.size, info: { calls: c.renderer.info.render.calls, programs: c.renderer.info.programs?.length, textures: c.renderer.info.memory.textures, geometries: c.renderer.info.memory.geometries } }
})
console.log(JSON.stringify(facts, null, 1))
ok('the world has facades', !facts.none && facts.st.layers > 0, facts.none ? 'site.facades() is null' : `${facts.st.layers} materials in one ${facts.st.px}² array, ${(facts.st.atlasBytes / 1e6).toFixed(1)} MB with mips`)
ok('the atlas loaded', facts.st?.loaded && !facts.st?.failed, facts.st?.failed ?? 'yes')
ok('footprints are classed into more than one class', Object.keys(facts.byClass ?? {}).filter((k) => k !== 'none').length >= 3, JSON.stringify(facts.byClass))
ok('most massing vertices are drawn from a pool', facts.textured > facts.total * 0.5, `${facts.textured} of ${facts.total}`)
const houses = facts.perClass?.house ?? []
ok('a class with a pool draws more than one material from it — variety', houses.length >= 2, `house: ${houses.join(', ')}`)
ok('every cell compiles to the one facade program', facts.programs?.length === 1 && facts.programs[0] === 'facades-v1', JSON.stringify(facts.programs))

if (SHOTS && street) {
  await look(street.x, street.y, 30, 7, 3)
  await page.waitForTimeout(4000)
  await page.screenshot({ path: `${SHOTS}/facades-street-${WORLD}.png`, timeout: 300000 })
}

// REFLECTIVENESS REACHES THE PIXELS: the street's own class, drawn matte and then mirror-smooth
const sample = () => page.evaluate(() => {
  const c = window.corridor
  c.renderer.render(c.scene, c.camera)
  const gl = c.renderer.getContext()
  const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px)
  return Array.from(px.filter((_, i) => i % 64 === 0))
})
const surf = (m, r) => page.evaluate(([m, r]) => window.corridor.site.facades()?.setSurface('house', { metalness: m, roughness: r }), [m, r])
await surf(0, 0.9)
const matte = await sample()
await surf(0.9, 0.08)
const shiny = await sample()
await surf(0, 0.9)
let diff = 0
for (let i = 0; i < matte.length; i++) diff += Math.abs(matte[i] - shiny[i])
ok('a class’s reflectiveness changes what is drawn', diff / matte.length > 1, `mean |Δ| ${(diff / matte.length).toFixed(2)} over ${matte.length} samples`)
ok('no page errors', errors.length === 0, errors[0] ?? 'none')
await page.close()

// AND OFF: the knob as the F6 panel keeps it, the same questions, nothing pooled
const off = await browser.newPage({ viewport: { width: 1280, height: 760 } })
await off.addInitScript(() => { try { localStorage.setItem('apex-corridor-world.tune.v1', JSON.stringify({ v: 2, values: { BUILDING_FACADES: 0 }, touched: ['BUILDING_FACADES'] })) } catch { /* */ } })
await off.goto(`http://127.0.0.1:${PORT}/?ui=dev#${WORLD}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await off.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, WORLD, { timeout: 300000 })
if (street) await off.evaluate(([x, y]) => { const c = window.corridor; const gy = c.site.groundAt(x + 24, -(y - 18)) ?? 0; c.camera.position.set(x + 24, gy + 7, -(y - 18)); c.orbit.target.set(x, gy + 3, -y); c.orbit.update() }, [street.x, street.y])
for (let i = 0; i < 120; i++) { if (await off.evaluate(() => { let n = 0; window.corridor.scene.traverse((o) => { if (o.name === 'buildings:massing') n++ }); return n })) break; await off.waitForTimeout(2000) }
const offFacts = await off.evaluate(() => {
  const c = window.corridor
  let textured = 0, total = 0
  c.scene.traverse((o) => { if (o.name !== 'buildings:massing') return; const lay = o.geometry.getAttribute('layer')?.array ?? []; total += lay.length; for (const v of lay) if (v >= 0) textured++ })
  return { facades: !!c.site.facades(), textured, total }
})
ok('with BUILDING_FACADES 0 there are no facades and nothing is pooled — the checks above can fail', !offFacts.facades && offFacts.total > 0 && offFacts.textured === 0, JSON.stringify(offFacts))
await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: buildings are classed and drawn from their pools')
process.exit(fails.length ? 1 : 0)
