// Is the loop a thing you can HIT, not just a thing you can see?
//
// Rich, 2026-09-29: *"the stunts are not drivable yet, we need to make them into actual roads."*
//
// The failure this exists for is the worst kind: a surface that renders perfectly and is not there.
// Every screenshot says the loop is solid; the car falls through it. So the assertions are about
// the PHYSICS — a collider exists, and a ray cast at the loop's inside face hits something.
import { chromium } from 'playwright'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const FILE = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/stunts.json`
const VIEWER = process.env.VIEWER ?? 'http://127.0.0.1:5185/index.html'

// author a fixture on the spine, the way the editor would
const doc = {
  version: 1,
  fixtures: [{
    id: 'drive-loop', name: 'Drive loop', piece: 'loop',
    at: [0, 0], yaw_deg: 0, style: 'stuntin',
    entry_s: 0, exit_s: 0, chain: 0,
  }],
}

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.fulfill({
  status: 200,
  contentType: 'application/javascript',
  /*
   * A STUB, NOT A BLOCK. Vite rewrites every module to import this for `import.meta.hot`, so
   * aborting it stops the app loading at all — measured: the site never appeared and the run timed
   * out after four minutes. Fulfilling it with the same shape and no websocket keeps the modules
   * loading and stops HMR navigating away mid-drive, which destroys the page's execution context
   * and throws the measurement away.
   */
  body: [
    'export const createHotContext = () => ({ accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{} })',
    'export const updateStyle = () => {}',
    'export const removeStyle = () => {}',
    'export const injectQuery = (u) => u',
    'export const ErrorOverlay = class {}',
    'export default {}',
  ].join('\n'),
}))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

// place it on the real road: load once to read the spine, then write the file and reload
await p.goto(`${VIEWER}?phys=1#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site, null, { timeout: 240000 })
await p.waitForTimeout(6000)
const where = await p.evaluate(() => {
  const site = window.__apex.site
  const mid = site.manifest.spine.length_m / 2
  const a = site.spineAt(mid - 60).pos
  const c = site.spineAt(mid + 60).pos
  const here = site.spineAt(mid).pos
  return {
    at: [here.x, -here.z],
    yaw: (Math.atan2(-(c.z - a.z), c.x - a.x) * 180) / Math.PI,
    entry: mid - 140, exit: mid + 140,
  }
})
doc.fixtures[0].at = where.at
doc.fixtures[0].yaw_deg = where.yaw
doc.fixtures[0].entry_s = where.entry
doc.fixtures[0].exit_s = where.exit
writeFileSync(FILE, JSON.stringify(doc, null, 1))

await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site && !!window.__apex?.stunts, null, { timeout: 240000 }).catch(() => {})
await p.waitForTimeout(10000)

const out = await p.evaluate(() => {
  const ap = window.__apex
  const w = ap.stunts
  if (!w) return { error: 'the world has no stunt fixtures' }
  const phys = ap.physics
  if (!phys) return { error: 'physics is off' }
  const surfaces = phys.stuntSurfaces?.() ?? []

  /*
   * IS IT WHERE IT LOOKS? A registered collider proves nothing about its position. `groundUnder`
   * casts a ray straight down, so at the loop's centre it should come back ABOVE the terrain — it
   * hits the top of the loop on the way down — while a point well off to the side comes back at
   * the terrain. That difference is the loop existing in the physics world.
   */
  const f = w.fixtures[0]
  const site = ap.site
  const phys2 = ap.physics
  const wx = f.at[0]
  const wz = -f.at[1]
  // the physics needs a step before a new collider is visible to a query
  const terrainHere = site.groundAt(wx, wz) ?? site.heightAt(f.at[0], f.at[1]) ?? 0
  const overLoop = phys2.groundUnder(wx, wz)
  const offToTheSide = phys2.groundUnder(wx + 400, wz + 400)
  return {
    surfaces, fixtures: w.count, id: f.id,
    terrainHere: +terrainHere.toFixed(2),
    overLoop: overLoop === null ? null : +overLoop.toFixed(2),
    offToTheSide: offToTheSide === null ? null : +offToTheSide.toFixed(2),
  }
})
console.log(JSON.stringify(out))
check(!out.error, out.error ?? 'the world loaded its fixtures')
if (!out.error) {
  check(out.fixtures === 1, 'one fixture in the world')
  // THE COLLIDER. Without this the loop is scenery.
  check(out.surfaces.includes('drive-loop'), `the loop has a physics surface (${out.surfaces.join(', ') || 'none'})`)
  check(out.overLoop !== null, 'a ray down at the loop hits something')
  // the top of a loop is about 36 m up, so the hit must be well above the terrain under it
  check(out.overLoop !== null && out.overLoop - out.terrainHere > 10,
    `and it hits the LOOP, not the ground (${out.overLoop} m against ${out.terrainHere} m of terrain)`)
  // the control: away from the fixture the same ray finds the ordinary ground
  check(out.offToTheSide === null || Math.abs(out.offToTheSide - out.terrainHere) < 40,
    `while a ray 400 m away finds the ordinary ground (${out.offToTheSide})`)
}

/*
 * AND A TRACK IN A FIELD IS DRIVEABLE TOO.
 *
 * Rich, 2026-09-29: *"That way I can build complete stunt tracks in a field."* A piece joined to
 * another piece rather than to a road has to be as solid as one over Route 450 — including the
 * CURVE BETWEEN THEM, which is the part with no road under it and the part a car lands on. So the
 * ray that matters here is the one cast half way along the join: over open ground, with nothing but
 * the connector to hit.
 */
const field = {
  version: 1,
  fixtures: [
    { id: 'field-a', name: 'A', piece: 'loop', at: [0, 0], yaw_deg: 0, style: 'stuntin', exit: { kind: 'fixture', id: 'field-b', port: 'entry' } },
    { id: 'field-b', name: 'B', piece: 'jump', at: [0, 0], yaw_deg: 0, style: 'stuntin', entry: { kind: 'fixture', id: 'field-a', port: 'exit' } },
  ],
}
// somewhere off the road entirely, and far enough from it that nothing else is under the ray
const spot = await p.evaluate(() => {
  const here = window.__apex.site.spineAt(window.__apex.site.manifest.spine.length_m / 2).pos
  return [here.x + 300, -here.z + 300]
})
field.fixtures[0].at = spot
field.fixtures[1].at = [spot[0] + 260, spot[1]]
writeFileSync(FILE, JSON.stringify(field, null, 1))

await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site && !!window.__apex?.stunts, null, { timeout: 240000 }).catch(() => {})
await p.waitForTimeout(10000)

const linked = await p.evaluate(async () => {
  const ap = window.__apex
  const w = ap.stunts
  if (!w) return { error: 'the world has no stunt fixtures' }
  const { fixturePorts } = await import('/src/stunts.ts')
  const site = ap.site
  const ground = (x, y) => site.groundAt(x, -y) ?? site.heightAt(x, y) ?? 0
  const a = w.fixtures.find((f) => f.id === 'field-a')
  const b = w.fixtures.find((f) => f.id === 'field-b')
  const from = fixturePorts(a, ground(a.at[0], a.at[1])).exit
  const to = fixturePorts(b, ground(b.at[0], b.at[1])).entry
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }
  return {
    surfaces: ap.physics?.stuntSurfaces?.() ?? [],
    gap: +Math.hypot(to.x - from.x, to.y - from.y).toFixed(1),
    terrain: +ground(mid.x, mid.y).toFixed(2),
    onTheJoin: ap.physics?.groundUnder(mid.x, -mid.y) ?? null,
    beside: ap.physics?.groundUnder(mid.x, -mid.y - 120) ?? null,
  }
})
console.log('field', JSON.stringify(linked))
check(!linked.error, linked.error ?? 'a track with no road under it loads')
if (!linked.error) {
  check(linked.surfaces.includes('field-a') && linked.surfaces.includes('field-b'),
    `both pieces are solid (${linked.surfaces.join(', ') || 'none'})`)
  check(linked.onTheJoin !== null, `the curve between them is there to drive on (${linked.gap} m of join)`)
  /*
   * AND THE CONTROL IS THE SAME RAY, 120 m TO THE SIDE. Out here there is no heightfield at all —
   * the terrain collider follows the corridor and this is three hundred metres off it — so a ray
   * that finds a surface on the join and nothing beside it can only have found the connector.
   * Asserting "above the terrain" instead would be wrong: two pieces standing on flat ground are
   * joined by a curve that lies ON that ground, which is what the numbers say.
   */
  check(linked.beside === null, `and nothing else is out there to have hit (${linked.beside})`)
  check(linked.onTheJoin !== null && Math.abs(linked.onTheJoin - linked.terrain) < 1.5,
    `the join lies on the field rather than floating over it (${linked.onTheJoin?.toFixed?.(2)} m against ${linked.terrain} m of ground)`)
}

// and a look at it, because "a track in a field" is a thing you judge with your eyes
await p.evaluate(() => {
  const ap = window.__apex
  const fs = ap.stunts.fixtures
  const mx = (fs[0].at[0] + fs[1].at[0]) / 2
  const my = (fs[0].at[1] + fs[1].at[1]) / 2
  const g = ap.site.groundAt(mx, -my) ?? 0
  const cam = ap.camera
  cam.position.set(mx - 40, g + 120, -my + 320)
  cam.lookAt(mx, g + 25, -my)
  ap.orbitTarget?.set?.(mx, g + 25, -my)
})
await p.waitForTimeout(2500)
await p.screenshot({ path: '/tmp/claude-1000/-workspaces-apex-conduit/12eaed6d-83ff-4605-9fb1-f5c0b0bc5019/scratchpad/stunt-field.png' })
console.log('shot stunt-field.png')

if (existsSync(FILE)) unlinkSync(FILE)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
