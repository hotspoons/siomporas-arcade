// In the actual game: does the engine move when the camera does?
//
// enginesim-spatial.mjs proves the spatialiser is right. This proves corridor is USING it right,
// which is a different question and the one that has historically gone wrong — the frame
// conversion (three is x east, y up, z south; the site is x east, y north, z up) and the order of
// operations inside the frame both have to be correct, and neither shows up in a screenshot.
//
//   PORT=5185 node probes/corridor-enginepos.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 900, height: 620 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 900000 })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }
const audio = () => page.evaluate(() => window.corridor.audio())

// Drive. The engine only speaks for an entity that has a voice, and only the driving mode gives
// the player's car one; `start()` needs a real gesture, which is what the keypress is.
//
// NO CLICK ON THE CANVAS FIRST. Tapping the viewport is itself "start driving", so click-then-Tab
// turns it on and straight back off — and the engine stays running, so the symptom is an audio
// context that is up with nothing to say and a probe that reports `undefined` rather than a
// failure. Tab is a gesture; that is all the browser wants.
await page.keyboard.press('Tab') // Tab is drive; G is Squishy Hunt
await page.waitForTimeout(1500)
await page.waitForFunction(() => window.corridor.audio().state === 'running' || window.corridor.audio().error,
  null, { timeout: 60000 }).catch(() => {})
const up = await audio()
ok('the engine is running', up.state === 'running', `state ${up.state}${up.error ? ` (${up.error})` : ''}`)
// Placement is null until a frame has voiced the engine. Its absence is the shape of the
// click-then-Tab mistake above, so say so rather than throwing on `undefined.toFixed`.
await page.waitForFunction(() => window.corridor.audio().distance !== undefined, null, { timeout: 30000 })
  .catch(() => {})
const voiced = await audio()
ok('and it is voicing the car', voiced.distance !== undefined,
  voiced.distance === undefined ? 'no placement: is drive mode actually on?' : 'placed')
if (up.state !== 'running' || voiced.distance === undefined) {
  await browser.close(); console.log('\nFAIL: no audio to measure'); process.exit(1)
}

// Chase camera: the car is several metres away, so the sound is outside and panned.
await page.waitForTimeout(600)
const chase = await audio()
ok('in chase view the car is a few metres off', chase.distance > 2 && chase.distance < 25,
  `${chase.distance.toFixed(2)} m`)
ok('and the mix is mostly the exterior bus', chase.interior < 0.2, `interior ${chase.interior.toFixed(3)}`)

// Cockpit. The ears move to the driver's head, so the distance collapses and the crossfade goes
// fully interior — this is the whole reason there are two buses.
//
// Set through the exposed `drive` handle rather than by pressing C. Keystrokes into a canvas are
// delivered when the page feels like it and two runs of this probe disagreed about whether the
// first C had landed; this probe is about the audio, and a flaky input layer in the middle of it
// measures the input layer. The keybinding has its own probe.
await page.evaluate(() => { const c = window.corridor; c.drive.cockpit = true; c.car.setCockpit(true) })
await page.waitForFunction(() => window.corridor.audio().interior > 0.9, null, { timeout: 15000 })
  .catch(() => {})
const cockpit = await audio()
ok('in the cockpit the ears are in the car', cockpit.distance < chase.distance,
  `${chase.distance.toFixed(2)} m → ${cockpit.distance.toFixed(2)} m`)
ok('and the mix goes to the cabin bus', cockpit.interior > 0.8, `interior ${cockpit.interior.toFixed(3)}`)
ok('with no attenuation: you are sitting on it', cockpit.attenuation > 0.95,
  `gain ${cockpit.attenuation.toFixed(3)}`)

// Back out of the cockpit and pull the chase camera right back, so the attenuation has to bite.
//
// Through the tuning knob, NOT by writing camera.position: the chase camera re-derives itself from
// the car every frame and lerps toward it, so a probe that teleports the camera is overwritten
// before the next audio update and measures the distance it was always going to measure. (It
// reported 1 m and a gain of 1.0 — the car, not the camera, which is the tell.)
await page.evaluate(() => { const c = window.corridor; c.drive.cockpit = false; c.car.setCockpit(false) })
const knob = await page.evaluate(() => window.corridor.tune.set('CHASE_BACK', 30))
ok('the chase-distance knob took', knob === true, `tune.set returned ${knob}`)
// Wait for the camera to SETTLE, not for a deadline. The chase camera lerps, and under
// swiftshader the frame loop stalls for seconds at a time while tiles stream — a fixed sleep read
// 24.0 m on a 30 m knob and called it a failure, which is a probe measuring the tile loader.
await page.waitForFunction(() => {
  const d = window.corridor.audio().distance
  const prev = window.__lastD
  window.__lastD = d
  return prev !== undefined && Math.abs(d - prev) < 0.05 && d > 20
}, null, { timeout: 60000, polling: 400 }).catch(() => {})
const far = await audio()
ok('pulled back to 30 m the attenuation actually bites',
  far.distance > 20 && far.attenuation < 0.2 && far.attenuation > 0.02,
  `${far.distance.toFixed(1)} m, gain ${far.attenuation.toFixed(4)}`)
ok('and it is fully exterior again', far.interior === 0, `interior ${far.interior}`)
// The curve, not just "smaller": the same inverse model spatial.ts claims to implement.
const curve = 2.5 / (2.5 + 0.9 * (far.distance - 2.5))
ok('on the inverse-distance curve we advertise',
  Math.abs(far.attenuation - curve) < 1e-3, `measured ${far.attenuation.toFixed(4)}, curve ${curve.toFixed(4)}`)

// ── leave the car and fly away ────────────────────────────────────────────────────────────────
//
// The car keeps existing when you stop driving it, and the engine used to keep sounding exactly as
// it did the instant you left — frozen at the last listener position, so flying a hundred metres
// off changed nothing at all. The ears belong to whoever is looking, in every mode.
const parked = await audio()
await page.keyboard.press('Tab') // out of drive, into the free camera
await page.waitForFunction(() => window.corridor.drive.on === false, null, { timeout: 15000 }).catch(() => {})
const leftIt = await page.evaluate(() => window.corridor.drive.on)
ok('we are out of the car', leftIt === false, `drive.on ${leftIt}`)
await page.evaluate(() => {
  const c = window.corridor
  // straight up, so the fly camera cannot be dragged back by anything that follows the car
  c.camera.position.y += 150
})
await page.waitForFunction(() => window.corridor.audio().distance > 100, null, { timeout: 20000 })
  .catch(() => {})
const flown = await audio()
ok('flying away makes the engine recede',
  flown.distance > parked.distance + 50, `${parked.distance.toFixed(1)} m → ${flown.distance.toFixed(1)} m`)
ok('and the attenuation follows it down',
  flown.attenuation < parked.attenuation / 2,
  `gain ${parked.attenuation.toFixed(4)} → ${flown.attenuation.toFixed(4)}`)

// ── nobody is looking ─────────────────────────────────────────────────────────────────────────
//
// A corridor tab behind a video call was a fan that never stopped: the browser throttles a hidden
// tab's timers but keeps its audio thread at full rate, and this engine is a rigid-body solver
// running inside the audio callback.
//
// visibilityState is faked rather than actually backgrounding the window — headless Chromium will
// not reliably background itself, and the thing under test is corridor's handler, not the
// browser's bookkeeping. The gain and the context state are then read from the REAL audio graph,
// which is the half that could not be faked.
const setHidden = (hidden) => page.evaluate((hidden) => {
  Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true })
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  document.hasFocus = () => !hidden
  dispatchEvent(new Event('visibilitychange'))
}, hidden)

const audible = await audio()
ok('while you are looking at it, it is not muted', audible.muted === false && audible.ctx === 'running',
  `muted ${audible.muted}, context ${audible.ctx}`)

await setHidden(true)
await page.waitForFunction(() => window.corridor.audio().ctx === 'suspended', null, { timeout: 15000 })
  .catch(() => {})
const hidden = await audio()
ok('hiding the tab mutes it', hidden.muted === true, `muted ${hidden.muted}`)
// The flag is what we asked for; the context state is what happened. Checking only the flag would
// pass on a build where the suspend never fires and the core keeps burning.
ok('and suspends the context, which is the half that stops burning a core',
  hidden.ctx === 'suspended', `context ${hidden.ctx}`)

await setHidden(false)
await page.waitForFunction(() => window.corridor.audio().ctx === 'running', null, { timeout: 15000 })
  .catch(() => {})
const backAgain = await audio()
ok('coming back unmutes and resumes', backAgain.muted === false && backAgain.ctx === 'running',
  `muted ${backAgain.muted}, context ${backAgain.ctx}`)
// and it is still voicing the car afterwards, rather than having come back deaf
await page.waitForTimeout(600)
const after = await audio()
ok('and it is still voicing the car afterwards', after.distance !== undefined,
  after.distance === undefined ? 'no placement after resume' : `${after.distance.toFixed(1)} m`)

await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: the engine follows the camera')
process.exit(fails.length ? 1 : 0)
