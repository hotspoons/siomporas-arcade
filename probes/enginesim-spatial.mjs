// Does the engine actually come from where the car is?
//
// Rich, 2026-09-27: "make sure we add the ability to position the sound in 3D and do attenuation
// and all that for first and third person cameras etc."
//
// WHY THIS RENDERS AUDIO INSTEAD OF READING BACK AudioParams. Every spatial-audio bug I can think
// of survives an AudioParam check: a panner set to the right coordinates in the wrong frame, a
// listener basis that is silently NaN, a crossfade with a hole in it, a left/right inversion. All
// of those leave the numbers looking exactly as intended. So this builds the REAL SpatialVoice in
// an OfflineAudioContext, feeds it a tone, renders it, and measures the two channels that come
// out — the same thing an ear does.
//
// It also mirrors the world and demands the verdict flip. A left/right test that cannot report
// "right" is not a test, and I have inverted a bearing comparison twice in this repo.
//
//   node probes/enginesim-spatial.mjs
import { chromium } from 'playwright'
import { build } from 'esbuild'

// Both files, not just voice.ts: the geometry is in spatial.ts and the probe asserts it directly
// as well as through what comes out of the speakers. NOT index.ts — that drags in the worklet and
// the catalog, neither of which an OfflineAudioContext has any use for.
const bundle = await build({
  stdin: {
    contents: "export * from './spatial'; export * from './voice'",
    resolveDir: 'packages/enginesim/src', loader: 'ts',
  },
  bundle: true, format: 'iife', globalName: 'Spatial', write: false, target: 'es2020',
})
const code = bundle.outputFiles[0].text

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.goto('about:blank')
await page.addScriptTag({ content: code })

/**
 * Render one placement and return what came out of each ear.
 *
 * `glide` is short here on purpose: setTargetAtTime is an exponential approach and the default
 * 50 ms would still be settling when a 0.5 s render ended, which would make every measurement a
 * measurement of the ramp.
 */
const measure = await page.evaluateHandle(() => async (source, listener, opts, hz = 220) => {
  const RATE = 48000, SECONDS = 0.5
  const ctx = new OfflineAudioContext(2, RATE * SECONDS, RATE)
  const osc = ctx.createOscillator()
  osc.frequency.value = hz
  const voice = new Spatial.SpatialVoice(ctx, { ...opts, glide: 0.002 })
  voice.connectFrom(osc)
  voice.out.connect(ctx.destination)
  const placement = voice.place(source, listener, { ...opts, glide: 0.002 })
  osc.start()
  const buf = await ctx.startRendering()
  // skip the first 100 ms so the ramps are done
  const skip = Math.floor(RATE * 0.1)
  const rms = (ch) => {
    const d = buf.getChannelData(ch)
    let s = 0
    for (let i = skip; i < d.length; i++) s += d[i] * d[i]
    return Math.sqrt(s / (d.length - skip))
  }
  const [l, r] = [rms(0), rms(1)]
  return { l, r, total: Math.hypot(l, r), placement, state: voice.state }
})

const run = (source, listener, opts = {}, hz) =>
  page.evaluate(([f, s, l, o, h]) => f(s, l, o, h), [measure, source, listener, opts, hz])

// The ears: at the origin, facing NORTH, head up. Site frame — x east, y north, z up.
const north = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 } }
const south = { ...north, forward: { x: 0, y: -1, z: 0 } }
const bias = (m) => (m.l - m.r) / (m.l + m.r) // +1 all left, -1 all right

const fails = []
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`)
  if (!cond) fails.push(name)
}

// ── 1. left is left, right is right, and turning around swaps them ───────────────────────────
const west = await run({ x: -20, y: 0, z: 0 }, north)
const east = await run({ x: 20, y: 0, z: 0 }, north)
ok('a car to the west is in the left ear', bias(west) > 0.8, `bias ${bias(west).toFixed(3)}`)
ok('a car to the east is in the right ear', bias(east) < -0.8, `bias ${bias(east).toFixed(3)}`)
// THE PROBE'S OWN CONTROL: mirroring the world must flip the verdict. If both came back the same
// the measurement is not reading the panner at all.
ok('mirroring the world flips the ear',
  Math.sign(bias(west)) === -Math.sign(bias(east)) && Math.abs(bias(west) - bias(east)) > 0.4,
  `west ${bias(west).toFixed(3)} vs east ${bias(east).toFixed(3)}`)
// Turn the listener around and the SAME car must change ears. This is the inversion that looks
// right in every static screenshot — and the one I have got backwards twice in this repo.
const eastFacingSouth = await run({ x: 20, y: 0, z: 0 }, south)
ok('turning around moves the car to the other ear',
  bias(eastFacingSouth) > 0.8, `facing north ${bias(east).toFixed(3)}, facing south ${bias(eastFacingSouth).toFixed(3)}`)
// HRTF is a knob, not the default (see INTERIOR_MATCH in voice.ts for the measurement that
// decided that). It still has to get the DIRECTION right — but per-channel level is the wrong
// instrument for it: at 220 Hz a real head barely shadows and the cue is interaural DELAY, which
// an RMS cannot see. So this asks at 3 kHz, where the shadow is real, and only checks the sign.
const hrtfWest = await run({ x: -20, y: 0, z: 0 }, north, { hrtf: true }, 3000)
const hrtfEast = await run({ x: 20, y: 0, z: 0 }, north, { hrtf: true }, 3000)
ok('with HRTF on, the sides are still the right way round',
  bias(hrtfWest) > 0.05 && bias(hrtfEast) < -0.05,
  `west ${bias(hrtfWest).toFixed(3)}, east ${bias(hrtfEast).toFixed(3)}`)

// ── 2. distance attenuates, on the curve we claim ────────────────────────────────────────────
const near = await run({ x: 0, y: 10, z: 0 }, north)
const far = await run({ x: 0, y: 40, z: 0 }, north)
const inverse = (d, ref = 2.5, roll = 0.9, max = 400) =>
  ref / (ref + roll * (Math.min(Math.max(d, ref), max) - ref))
const wanted = inverse(40) / inverse(10)
const got = far.total / near.total
ok('40 m is quieter than 10 m', got < 0.8, `${got.toFixed(3)}× the level`)
ok('and by the inverse-distance curve, not some other one',
  Math.abs(got - wanted) < 0.12, `measured ${got.toFixed(3)}, curve says ${wanted.toFixed(3)}`)
// Past maxDistance it stops getting worse rather than going silent.
const beyond = await run({ x: 0, y: 5000, z: 0 }, north)
ok('beyond maxDistance it floors rather than vanishing', beyond.total > 1e-5,
  `rms ${beyond.total.toExponential(2)}`)

// ── 3. the cockpit: inside the car it stops being panned ─────────────────────────────────────
const cockpit = await run({ x: 0.4, y: 0.3, z: 0 }, north)
ok('sitting in the car, the crossfade is fully interior',
  cockpit.placement.interior > 0.95, `interior ${cockpit.placement.interior.toFixed(3)}`)
ok('and the sound stops being panned (this is the point of the second bus)',
  Math.abs(bias(cockpit)) < 0.03, `bias ${Math.abs(bias(cockpit)).toFixed(4)}`)
// The same geometry with the interior bus disabled MUST pan hard — otherwise the line above is
// passing because nothing is spatialised at all, which is a much worse bug that looks identical.
const cockpitNoBus = await run({ x: 0.4, y: 0.3, z: 0 }, north, { interiorM: 0, exteriorM: 0.01 })
ok('CONTROL: without the interior bus that same position pans hard',
  Math.abs(bias(cockpitNoBus)) > 0.4, `bias ${Math.abs(bias(cockpitNoBus)).toFixed(3)}`)

// ── 4. the chase camera sits in the crossfade, and the level does not step through it ─────────
//
// This is the assertion the two-bus design can most easily get wrong, and it cost a fix: a mono
// signal reaching a stereo output is up-mixed by COPYING, gain 1 into each channel, while an
// equal-power panner at centre puts 0.7071 into each. So the unpanned interior bus was 3 dB
// louder than the panned exterior one, and driving from cockpit to chase stepped the volume.
//
// Measured against the distance curve rather than against itself: of course it gets quieter over
// 0.5–8 m, that is what attenuation IS. What must not happen is a DEVIATION from that curve
// where the buses hand over.
const sweep = []
const dists = []
for (let d = 0.5; d <= 8; d += 0.5) { dists.push(d); sweep.push(await run({ x: 0, y: d, z: 0 }, north)) }
const flat = sweep.map((m, i) => m.total / inverse(dists[i]))
const lo = Math.min(...flat), hi = Math.max(...flat)
ok('the crossfade neither dips nor bumps: the level follows the distance curve throughout',
  hi / lo < 1.15, `${(hi / lo).toFixed(3)}× spread over 0.5–8 m (${lo.toFixed(3)}–${hi.toFixed(3)})`)
// And it is CONTINUOUS — no step between neighbouring samples, which is what a click sounds like.
const steps = flat.slice(1).map((v, i) => Math.abs(v / flat[i] - 1))
ok('and it is continuous, with no step to click on',
  Math.max(...steps) < 0.08, `biggest step ${(Math.max(...steps) * 100).toFixed(1)}% at ${dists[steps.indexOf(Math.max(...steps)) + 1]} m`)

// ── 5. the cabin is a lowpass ─────────────────────────────────────────────────────────────────
const inLow = await run({ x: 0.4, y: 0.3, z: 0 }, north, {}, 200)
const inHigh = await run({ x: 0.4, y: 0.3, z: 0 }, north, {}, 6000)
ok('inside the car, 6 kHz is muffled and 200 Hz is not',
  inHigh.total < inLow.total * 0.25, `6k/200 = ${(inHigh.total / inLow.total).toFixed(3)}`)
const outLow = await run({ x: 0, y: 20, z: 0 }, north, {}, 200)
const outHigh = await run({ x: 0, y: 20, z: 0 }, north, {}, 6000)
// The control that makes the line above mean something: the muffle must be the CABIN, not a
// lowpass left in the signal path. Equal-power is flat to four decimals at every frequency, so
// outside the car the two tones must come back at the same level. (With HRTF this control is
// worthless — its gain swings 5.25× across the band, which is exactly why it is not the default.)
ok('CONTROL: outside the car nothing is muffled',
  outHigh.total > outLow.total * 0.95, `6k/200 = ${(outHigh.total / outLow.total).toFixed(3)}`)

// ── 6. the degenerate listener, checked at the maths rather than at the speakers ──────────────
//
// Looking straight up makes forward parallel to up, and a naive Gram-Schmidt leaves a zero vector.
// Handed to Web Audio that is a NaN listener orientation, and everything goes silent with no error
// anywhere — but Chromium happens to cope, so a "is there still sound" check passes whether the
// maths is right or not. It is not a test; it is a coincidence. So this asks basis() directly for
// what it is supposed to produce: two unit vectors at right angles, finite.
const bases = await page.evaluate(() => {
  const cases = {
    'straight up': { forward: [0, 0, 1], up: [0, 0, 1] },
    'straight down': { forward: [0, 0, -1], up: [0, 0, 1] },
    'a zero forward vector': { forward: [0, 0, 0], up: [0, 0, 1] },
    'the ordinary case': { forward: [0, 1, 0], up: [0, 0, 1] },
    'up not perpendicular to forward': { forward: [0, 0.8, 0.6], up: [0, 0, 1] },
  }
  const out = {}
  for (const [name, c] of Object.entries(cases)) {
    const b = Spatial.basis({
      position: { x: 0, y: 0, z: 0 },
      forward: { x: c.forward[0], y: c.forward[1], z: c.forward[2] },
      up: { x: c.up[0], y: c.up[1], z: c.up[2] },
    })
    const len = (v) => Math.hypot(v.x, v.y, v.z)
    out[name] = {
      f: len(b.forward), u: len(b.up),
      dot: b.forward.x * b.up.x + b.forward.y * b.up.y + b.forward.z * b.up.z,
    }
  }
  return out
})
for (const [name, m] of Object.entries(bases)) {
  ok(`${name}: the basis is orthonormal and finite`,
    Number.isFinite(m.f) && Number.isFinite(m.u) && Number.isFinite(m.dot) &&
    Math.abs(m.f - 1) < 1e-6 && Math.abs(m.u - 1) < 1e-6 && Math.abs(m.dot) < 1e-6,
    `|f| ${m.f.toFixed(6)}, |u| ${m.u.toFixed(6)}, f·u ${m.dot.toExponential(1)}`)
}
// And the audio still comes out, which is the consequence rather than the mechanism.
const straightUp = await run({ x: 0, y: 20, z: 0 },
  { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 0, z: 1 } })
ok('looking straight up does not silence the world',
  Number.isFinite(straightUp.total) && straightUp.total > 1e-4, `rms ${straightUp.total.toExponential(2)}`)

await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: the engine comes from where the car is')
process.exit(fails.length ? 1 : 0)
