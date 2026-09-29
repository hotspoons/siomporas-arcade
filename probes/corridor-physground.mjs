// Does the ground the PHYSICS thinks is there agree with the ground you can see?
//
//   node probes/corridor-physground.mjs [site]
//
// This is step 1 of docs/corridor/PLAN-PHYSICS.md, and it is the only question worth asking before
// there is a car on it. Every bug this app has ever had of the form "the car shakes" or "green
// stuff on the road" has been two surfaces modelling the same ground at different samplings, and
// the physics heightfield is a third opportunity to do exactly that. `site.groundAt` is the one
// height function everything else stands on; `physics.groundUnder` ray-casts the heightfield the
// wheels will stand on. They have to agree.
//
// THE CONTROL IS THE POINT. Comparing groundAt(x,z) with groundUnder(x,z) and finding them equal
// proves nothing on its own: over flat ground a TRANSPOSED heightfield, a heightfield at the wrong
// origin, and a correct one all agree. So the same comparison is run against a DELIBERATELY SHIFTED
// sample — groundUnder(x, z) against groundAt(x + SHIFT, z) — and that one has to DISAGREE. If the
// shifted comparison also passes, the transect is too flat to be measuring anything and the probe
// says so and exits non-zero rather than reporting a green result it did not earn.
import { chromium } from 'playwright'

const site = process.argv[2] ?? 'bowie-racetrack-rd'
const PORT = process.env.CORRIDOR_PORT ?? '5185'
const SHIFT = 12 // metres: the control offset. Bigger than a tile cell, smaller than a road
const TOL = 0.05 // metres: what counts as agreement between the two surfaces

// swiftshader without the angle wrapper, and /dev/shm out of the picture: a container's 64 MB
// shm is what takes a big site's tab down with "Target crashed" before a line of probe code runs.
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())

// `window.corridor.site` being non-null is the ready signal. NOT `#status`: the older probes wait
// on a status element that the UI rebuild removed, so that condition can never become true and the
// probe times out having loaded the world perfectly well.
const ready = () => page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 240000 })

// `?phys=1`, not the F6 knob. PHYS_ENABLED is read once, when the site builds, and `tune.set`
// persists NOTHING — measured: set it, reload, and it is back to the default with the physics
// never started. A load-time knob needs a load-time switch.
await page.goto(`http://127.0.0.1:${PORT}/?lite&phys=1#${site}`, { waitUntil: 'load' })
await ready()
await page.waitForFunction(() => !!window.corridor.physics, null, { timeout: 120000 })

/*
 * Build the tiles by calling `update` directly rather than waiting for frames.
 *
 * Headless swiftshader renders this scene at well under one frame a second, so waiting on the frame
 * loop to build tiles at PHYS_TILE_BUDGET per frame would take minutes and the probe would time out
 * having measured nothing. The same trick corridor-car.mjs uses on the car.
 */
const result = await page.evaluate(({ SHIFT, TOL }) => {
  const a = window.corridor
  const phys = a.physics
  const site = a.site

  // Stand on the spine a third of the way along, which on every baked site is road rather than the
  // ragged ends of the extract.
  const s0 = site.manifest.spine.length_m ? site.manifest.spine.length_m / 3 : 500
  const here = site.spineAt(s0).pos

  const t0 = performance.now()
  for (let i = 0; i < 120; i++) phys.update(here, 1 / 60)
  const buildMs = performance.now() - t0

  const samples = []
  const step = 4
  for (let k = -20; k <= 20; k++) {
    const p = site.spineAt(s0 + k * step).pos
    // sample on the crown and a few metres either side, so the transect crosses camber and verge
    for (const off of [0, 3, -3]) {
      const x = p.x + off
      const z = p.z
      const seen = site.groundAt(x, z)
      const solid = phys.groundUnder(x, z)
      const shifted = site.groundAt(x + SHIFT, z)
      if (seen === null || solid === null) continue
      samples.push({
        x: +x.toFixed(2),
        z: +z.toFixed(2),
        seen: +seen.toFixed(3),
        solid: +solid.toFixed(3),
        dz: +(solid - seen).toFixed(4),
        control: shifted === null ? null : +(solid - shifted).toFixed(4),
      })
    }
  }

  const med = (xs) => {
    const s = [...xs].sort((p, q) => p - q)
    return s.length ? +s[Math.floor(s.length / 2)].toFixed(4) : null
  }
  const abs = samples.map((s) => Math.abs(s.dz))
  const ctl = samples.filter((s) => s.control !== null).map((s) => Math.abs(s.control))
  // `w?.dz ?? -1` through Math.abs is 1, which silently means "only replace when worse than a
  // metre" and reports null on any healthy run. Seed with the first sample instead.
  const worst = samples.reduce((w, s) => (w === null || Math.abs(s.dz) > Math.abs(w.dz) ? s : w), null)

  return {
    site: site.manifest.slug,
    stats: phys.stats(),
    buildMs: +buildMs.toFixed(1),
    samples: samples.length,
    agree: { median: med(abs), worst: worst ? Math.abs(worst.dz) : null, at: worst, over: abs.filter((d) => d > TOL).length },
    control: { median: med(ctl), over: ctl.filter((d) => d > TOL).length, of: ctl.length },
    relief: { min: Math.min(...samples.map((s) => s.seen)), max: Math.max(...samples.map((s) => s.seen)) },
  }
}, { SHIFT, TOL })

console.log(JSON.stringify(result, null, 1))
await browser.close()

/* ---- the verdict ------------------------------------------------------------------------------ */

const fail = []
if (!result.samples) fail.push('no samples: the physics answered null everywhere — no tiles were built')
if (result.stats.tiles === 0) fail.push('no heightfield tiles exist')
if (result.agree.median === null || result.agree.median > TOL) fail.push(`the two surfaces disagree: median |dz| ${result.agree.median} m > ${TOL}`)
if (result.agree.over > result.samples * 0.05) fail.push(`${result.agree.over}/${result.samples} samples disagree by more than ${TOL} m`)
// The control: a wrong sampling MUST look wrong, or this probe is measuring a flat field.
if (result.control.of && result.control.over < result.control.of * 0.5) {
  fail.push(`the control passed: shifting the sample ${SHIFT} m changed the height by less than ${TOL} m in ${result.control.of - result.control.over}/${result.control.of} places — this transect is too flat to prove anything`)
}

if (fail.length) {
  for (const f of fail) console.error('FAIL', f)
  process.exit(1)
}
console.log(`ok — ${result.samples} samples, median |dz| ${result.agree.median} m, worst ${result.agree.worst} m over ${(result.relief.max - result.relief.min).toFixed(1)} m of relief; control median ${result.control.median} m`)
