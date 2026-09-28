// Does each craft in the library actually fly differently, in the real viewer?
//
// transport.test.ts proves the physics against flat ground and open sky. This proves the half that
// only the page can answer: that taking a craft moves the camera, that the ground under it is the
// real terrain rather than y = 0, that switching does not leave two controllers fighting over one
// camera, and that the craft are distinguishable in flight rather than being one model with seven
// names.
//
//   node probes/corridor-transport.mjs
import { chromium } from 'playwright'

const url = process.env.PROBE_URL ?? 'http://localhost:5185/?lite#arrowhead-farms'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForFunction(() => typeof window.corridor?.craft === 'function', null, { timeout: 60000 })
await page.keyboard.press('Enter')
await page.waitForTimeout(2000)

const fail = []
const say = (k, v) => console.log(`${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

/**
 * Take a craft, hold some keys for a while and report where it got to.
 *
 * REAL FRAMES, not a loop over `step`: the point is that the viewer's frame loop drives it and the
 * camera follows. This page runs at under a frame a second under SwiftShader, so the run is
 * counted in frames rather than in wall-clock seconds.
 */
async function flight(kind, keys, frames = 12) {
  return page.evaluate(async ({ kind, keys, frames }) => {
    const a = window.corridor
    a.craft(kind)
    const t = a.transport
    const before = { at: { ...t.state.at }, cam: a.camera.position.toArray().map((n) => +n.toFixed(2)) }
    // press the keys the way a person does, so the binding is under test too
    for (const k of keys) dispatchEvent(new KeyboardEvent('keydown', { code: k, bubbles: true }))
    for (let i = 0; i < frames; i += 1) await new Promise((r) => requestAnimationFrame(() => r(null)))
    for (const k of keys) dispatchEvent(new KeyboardEvent('keyup', { code: k, bubbles: true }))
    const r = t.readout()
    return {
      before,
      at: { ...t.state.at },
      cam: a.camera.position.toArray().map((n) => +n.toFixed(2)),
      speed: +r.speed.toFixed(2),
      altitude: +r.altitude.toFixed(2),
      stalled: r.stalled,
      grounded: r.grounded,
      moved: +Math.hypot(t.state.at.x - before.at.x, t.state.at.y - before.at.y, t.state.at.z - before.at.z).toFixed(2),
      pitch: +t.state.pitch.toFixed(3),
      roll: +t.state.roll.toFixed(3),
    }
  }, { kind, keys, frames })
}

// 1. every craft can be taken, and taking one puts the camera somewhere sensible
for (const kind of ['walk-third', 'helicopter', 'omnicopter', 'ornithopter', 'plane', 'jet', 'ufo']) {
  const r = await flight(kind, ['KeyW', 'ShiftLeft'], 10)
  say(kind, { moved: r.moved, speed: r.speed, alt: r.altitude, grounded: r.grounded, stalled: r.stalled })
  if (!Number.isFinite(r.at.x) || !Number.isFinite(r.at.y)) fail.push(`${kind}: the state went to NaN in the page`)
  if (!Number.isFinite(r.cam[0]) || !Number.isFinite(r.cam[1])) fail.push(`${kind}: the camera went to NaN`)
  // the camera must be somewhere near the craft, not left where the free camera had it
  const d = Math.hypot(r.cam[0] - r.at.x, r.cam[1] - r.at.y, r.cam[2] - r.at.z)
  if (d > 200) fail.push(`${kind}: the camera is ${d.toFixed(0)} m from the craft — it is not following`)
  if (r.altitude < -1) fail.push(`${kind}: it is ${(-r.altitude).toFixed(1)} m underground`)
  // A WING TAKEN IN THE AIR MUST BE FLYING. With no airspeed it is stalled on the first frame and
  // the only thing it can do is hit the ground, which is correct physics and an unusable mode.
  if (['plane', 'jet'].includes(kind) && r.stalled) fail.push(`${kind}: taken in mid-air it is stalled — it was given no airspeed`)
}

// 2. the ground under a craft is the real terrain, not zero
const ground = await page.evaluate(() => {
  const a = window.corridor
  a.craft('helicopter')
  const t = a.transport
  const g = a.site.groundAt(t.state.at.x, t.state.at.z)
  return { ground: g, y: t.state.at.y, clearance: +(t.state.at.y - (g ?? 0)).toFixed(2) }
})
say('terrain under the craft', ground)
if (ground.ground === null || Math.abs(ground.ground) < 1e-9) fail.push('the craft is standing on y = 0 — it is not reading the terrain')

// 3. they fly DIFFERENTLY. A UFO holds its height with no throttle; a plane does not.
const hover = await flight('ufo', [], 10)
say('a UFO left alone', { moved: hover.moved, alt: hover.altitude })
if (hover.moved > 0.01) fail.push(`a UFO with no input moved ${hover.moved} m`)

const glide = await page.evaluate(async () => {
  const a = window.corridor
  a.craft('plane')
  const t = a.transport
  // put it up high and give it flying speed, then let go of everything
  t.state.at.y += 400
  t.state.vel = { x: 0, y: 0, z: -70 }
  const y0 = t.state.at.y
  for (let i = 0; i < 25; i += 1) await new Promise((r) => requestAnimationFrame(() => r(null)))
  return { fell: +(y0 - t.state.at.y).toFixed(1), speed: +Math.hypot(t.state.vel.x, t.state.vel.y, t.state.vel.z).toFixed(1) }
})
say('a plane with the engine off', glide)
if (glide.fell <= 0) fail.push('a plane with no engine did not descend')

// 4. switching back leaves one controller in charge
const back = await page.evaluate(() => {
  const a = window.corridor
  a.craft('jet')
  const on = a.transport.enabled
  a.craft(null)
  return { whileFlying: on, afterwards: a.transport.enabled }
})
say('control handed back', back)
if (!back.whileFlying) fail.push('taking a craft did not enable its controls')
if (back.afterwards) fail.push('leaving a craft left its controls running — two things are writing the camera')

if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '))
try { await page.screenshot({ path: 'shots/transport.png', timeout: 120000 }) } catch { /* the verdict is the measurement */ }
await browser.close()
if (fail.length) { console.log('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1) }
console.log('\nPASS: every craft flies, follows the terrain, and hands the camera back')
