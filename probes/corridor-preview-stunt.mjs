// Is a loop you have just placed solid in the EDITOR'S PREVIEW, or only in the game?
//
// Rich, 2026-09-29: *"It doesn't look like that works in the preview from the editor."* It did not.
// The preview drives `Car` — which samples a height model, one height per column — and it had no
// physics world at all, so a fixture was something to look at and drive through. The viewer had
// just been taught to start physics for a world with stunts in it; the preview had not.
//
// The preview is where a track gets built, so this is the loop that matters: place, look, drive,
// adjust. Everything below goes through the editor's own buttons and keys.
import { chromium } from 'playwright'
import { existsSync, unlinkSync } from 'node:fs'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const EDITOR = process.env.EDITOR ?? 'http://127.0.0.1:5185/editor.html'
const FILE = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/stunts.json`
const SHOT = '/tmp/claude-1000/-workspaces-apex-conduit/12eaed6d-83ff-4605-9fb1-f5c0b0bc5019/scratchpad/preview-stunt.png'

if (existsSync(FILE)) unlinkSync(FILE)

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1200, height: 800 } })
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

await p.goto(`${EDITOR}#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 180000 })
await p.waitForTimeout(6000)

/*
 * THE CONTROL COMES FIRST: a world with no fixtures must preview exactly as it always has — the
 * hand-written car, no physics, no 4.3 MB import and no grid of heightfield colliders.
 */
await p.keyboard.press('v')
await p.waitForFunction(() => window.corridor.preview?.open === true, null, { timeout: 240000 })
await p.waitForTimeout(2500)
const plain = await p.evaluate(() => ({
  physics: !!window.corridor.preview.physics,
  car: window.corridor.preview.car?.constructor?.name ?? null,
}))
console.log('no stunts', JSON.stringify(plain))
check(!plain.physics, 'a world with no stunts previews with no physics, as it always has')
check(plain.car === 'Car', `and with the ordinary car (${plain.car})`)
await p.keyboard.press('Escape')
await p.waitForTimeout(1200)

// now place one, on the road, a little way ahead of where the preview starts you
const placed = await p.evaluate(() => {
  const st = window.corridor.stunts
  const site = window.corridor.site
  const at = site.spineAt(site.manifest.spine.photo_s + 250).pos
  st.arm('hump')
  const id = st.placeAt({ x: at.x, y: -at.z })
  return { id, fixtures: st.doc.fixtures.length }
})
console.log('placed', JSON.stringify(placed))
check(!!placed.id, 'a fixture is on the road')

await p.keyboard.press('v')
await p.waitForFunction(() => window.corridor.preview?.open === true, null, { timeout: 240000 })
await p.waitForTimeout(3500)

const ready = await p.evaluate(() => {
  const pv = window.corridor.preview
  return {
    physics: !!pv.physics, surfaces: pv.surfaces, car: pv.car?.constructor?.name ?? null, mode: pv.mode,
    profile: pv.profileId,
    power: pv.car?.profile?.powerPerKg ?? null,
    top: pv.car?.profile?.topSpeed ?? null,
    options: [...pv.carSel.querySelectorAll('optgroup')].map((g) => g.label),
  }
})
console.log('preview', JSON.stringify(ready))
check(ready.physics, 'the preview of a world with a stunt in it has a physics world')
check(ready.surfaces >= 1, `and the fixture is registered as a surface (${ready.surfaces})`)
check(ready.car === 'RapierCar', `and it drives the car that can hit one (${ready.car})`)
/*
 * AND IT IS THE FAST ONE. Rich, 2026-09-29: *"that car needs a lot more power in the preview…
 * can't get it fast enough to do a loop de loop"*. The preview span `street` — 7.5 m/s² per kilo
 * and 58 m/s — on a world made of loops. A stunt world gets the stunt car unless somebody has
 * said otherwise with the knob.
 */
check(ready.profile === 'stunts', `and the stunt car rather than the road one (${ready.profile})`)
check(ready.power >= 11 && ready.top >= 82, `with the power to get round a loop (${ready.power} m/s² per kg, ${ready.top} m/s top)`)
check(ready.options.includes('handling model'), `and a picker to change it live (${ready.options.join(', ')})`)

/*
 * THE PICKER IS LIVE. A profile read once at spawn is why the tuner looked broken: every change was
 * a change to the car you would get next time.
 */
const swapped = await p.evaluate(() => {
  const pv = window.corridor.preview
  const before = pv.car.profile.powerPerKg
  pv.setProfile('sim')
  const after = pv.car.profile.powerPerKg
  pv.setProfile('stunts')
  return { before, after, back: pv.car.profile.powerPerKg }
})
console.log('swapped', JSON.stringify(swapped))
check(swapped.after !== swapped.before && swapped.back === swapped.before,
  `changing the car changes the car you are driving (${swapped.before} → ${swapped.after} → ${swapped.back} m/s² per kg)`)

/*
 * AND THEN DRIVE IT, through the preview's own input: keys into the set its `tick` reads, and its
 * own `tick` stepping the world. Nothing here reaches past the preview into the physics.
 */
const drove = await p.evaluate(() => {
  const pv = window.corridor.preview
  const site = window.corridor.site
  const dt = 1 / 60
  pv.keys.add('KeyW')
  /*
   * AND IT HAS TO STEER. Race Track Road is not straight: holding the throttle with the wheel
   * centred puts the car in a field a hundred metres before the fixture, which is what the first
   * run of this measured (29 m/s, "grass", 1.5 m of gain). So the probe drives the road the way a
   * person does — by pressing A and D — aiming at a point twenty-five metres further along the
   * spine, and the station advances by how far the car has actually gone.
   */
  let station = site.manifest.spine.photo_s
  let best = { gain: 0, t: 0, speed: 0 }
  for (let i = 0; i < 60 * 16; i++) {
    const car0 = pv.car
    station += Math.max(0, car0.speed) * dt
    const aim = site.spineAt(Math.min(site.manifest.spine.length_m, station + 25)).pos
    const want = Math.atan2(aim.z - car0.pos.z, aim.x - car0.pos.x)
    let err = want - Math.atan2(car0.forward.z, car0.forward.x)
    while (err > Math.PI) err -= 2 * Math.PI
    while (err < -Math.PI) err += 2 * Math.PI
    pv.keys.delete('KeyA')
    pv.keys.delete('KeyD')
    if (err > 0.02) pv.keys.add('KeyD')
    else if (err < -0.02) pv.keys.add('KeyA')
    pv.tick(dt, i * dt)
    const car = pv.car
    const ground = site.groundAt(car.pos.x, car.pos.z) ?? 0
    const gain = car.pos.y - ground
    if (gain > best.gain) best = { gain: +gain.toFixed(2), t: +(i * dt).toFixed(1), speed: +car.speed.toFixed(1) }
  }
  pv.keys.clear()
  return { best, hud: pv.hud.textContent, station: +station.toFixed(0) }
})
console.log('drove', JSON.stringify(drove))
// the physics car really drives in here: it gets moving and stays on the road it is steered down
check(drove.best.speed > 5 && /pavement/.test(drove.hud ?? ''), `the physics car drives the preview (${drove.hud})`)
check(/car ·/.test(drove.hud ?? ''), 'and the HUD says which car you are in')

/*
 * AND THE FIXTURE HOLDS THE CAR UP.
 *
 * Dropped on the apex of the piece from three metres: if the surface is in the physics world the
 * car rests on it, and if it is not the car falls to the field several metres below. That is the
 * difference the whole change is about, and it is one second of simulation rather than a drive
 * across half a mile of county road.
 */
const dropped = await p.evaluate(async () => {
  const pv = window.corridor.preview
  const site = window.corridor.site
  const { fixturePath, standOn } = await import('/src/stunts.ts')
  const f = window.corridor.stunts.doc.fixtures[0]
  const ground = (x, y) => site.groundAt(x, -y) ?? site.heightAt(x, y) ?? 0
  const apex = fixturePath(f, 48, standOn(f, ground)).reduce((hi, q) => (q.z > hi.z ? q : hi))
  const terrain = ground(apex.x, apex.y)
  // straight down onto it, stationary, so nothing but the surface decides where it ends up
  pv.car.place(apex.x, -apex.y, 0)
  pv.car.vehicle.body.setTranslation({ x: apex.x, y: apex.z + 3, z: -apex.y }, true)
  const dt = 1 / 60
  for (let i = 0; i < 120; i++) {
    pv.car.tick(dt, { throttle: 0, brake: 0, steer: 0, handbrake: false })
    pv.physics.update(pv.car.pos, dt)
  }
  return {
    apex: +apex.z.toFixed(2),
    terrain: +terrain.toFixed(2),
    rest: +pv.car.pos.y.toFixed(2),
    clear: +(apex.z - terrain).toFixed(2),
  }
})
console.log('dropped', JSON.stringify(dropped))
check(dropped.clear > 2, `the fixture's apex stands clear of the field (${dropped.clear} m)`)
// resting ON it: within a car's own ride height of the surface, and nowhere near the ground below
check(Math.abs(dropped.rest - dropped.apex) < 2.5 && dropped.rest - dropped.terrain > 2,
  `and a car dropped on it rests there rather than in the field (${dropped.rest} m, surface ${dropped.apex} m, field ${dropped.terrain} m)`)

await p.screenshot({ path: SHOT })
console.log('shot', SHOT)

if (existsSync(FILE)) unlinkSync(FILE)
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
