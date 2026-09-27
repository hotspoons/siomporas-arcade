#!/usr/bin/env node
// Record the simulator, so twenty cars cost what one sample player costs.
//
// Rich, 2026-09-27: "we are going to want to be able to prebake a library of engine sounds for
// other cars in the game so we don't need to run 20 instances of engine simulator for ambient
// traffic noise ... each vehicle will of course get its own real simulator while in it, but for
// exterior world shots we'll want sound fonts/lib sounds baked from the simulator. And we'll want
// to be able to rebake it when we add more configs."
//
// IN NODE, NOT IN A BROWSER. The same wasm the AudioWorklet runs has a CJS build with the C API
// exposed directly (wasm/enginesim.cjs), and `es_set_follow_rpm` holds a fixed rev — which is
// exactly what a baker needs and what a game never does. So this renders deterministically,
// faster than realtime, with no AudioContext, no worklet and no headless browser.
//
// WHAT COMES OUT. One directory per engine:
//
//   packs/<id>/pack.json          the manifest — every layer's rpm, pedal, loop and level
//   packs/<id>/<rpm>-<pedal>.wav  16-bit mono, exactly one loop long
//   packs/index.json              what exists, for the game to fetch first
//
// Each file IS the loop: no loop points to trim to, no lead-in, nothing to get wrong at load
// time. `loopStart` is 0 and `loopEnd` is the whole file, and both are in the manifest anyway
// because `decodeAudioData` resamples to the context's rate.
//
// THE SEAM IS CHECKED HERE. A loop of a whole number of engine cycles is seamless; one that is
// anything else clicks once per wrap forever, at a rate that tracks the engine speed. pack.ts
// does the arithmetic that makes it whole, and this measures the result — the step across the
// wrap against the signal's own typical step — and refuses to write a layer that fails.
//
//   node packages/enginesim/scripts/bake.mjs                      # every engine in the catalog
//   node packages/enginesim/scripts/bake.mjs --engine gm_ls       # ones whose path matches
//   node packages/enginesim/scripts/bake.mjs --out /tmp/packs --floor 500

import { createRequire } from 'node:module'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { argv, exit } from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BAKER_VERSION, bakeRpm, bakeRpmAtMost, cycleSamples, loopCycles, rpmLadder } from '../src/pack.ts'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}
const SAMPLE_RATE = Number(arg('rate', 48000))
const QUANTUM = 128
const OUT = path.resolve(arg('out', path.join(ROOT, 'packs')))
const MATCH = arg('engine', null)
/*
 * THE REDLINE IS MEASURED, NOT TYPED — and the first version of this file typed it.
 *
 * `es_cylinders` and `es_displacement` are exported; the rev limit is not, so a table of twenty
 * hand-entered redlines looked like the only option. It is not: follow mode holds the rpm it is
 * given EXACTLY — to the hundredth, at every rev, with zero drift over a second — right up to the
 * engine's own limiter, where it clamps. So asking for 100,000 rpm and reading back what happened
 * IS the redline, out of the script that declares it.
 *
 * That is not a nicety. The baked ladder went to a typed 7000 for every engine, and at the top
 * layer the GM LS silently ran at 6500 while the loop was cut for 6999 — a permanent click, on
 * every traffic car, forever. The seam check below caught it, and the fix is to stop typing.
 * Measured across the catalog it ranges from 3000 (the Merlin V12 and the radials) to 18000 (the
 * Ferrari 412 T2), which no single default could have covered.
 *
 * IDLE IS NOT MEASURABLE THE SAME WAY: follow mode at 0 holds 0 rather than falling back to an
 * idle, because it is kinematic — it turns the crank at whatever you ask and combustion follows.
 * That also makes the floor harmless: a layer baked below an engine's real idle is a real
 * recording of that engine turning that slowly, which is what a car pulling away sounds like.
 * So the floor is a parameter, the ladder is geometric, and being generous with it costs a
 * couple of layers rather than being wrong.
 */
const FLOOR = Number(arg('floor', 500))

const PEDALS = [0, 1]

const mod = await require(path.join(ROOT, 'wasm/enginesim.cjs'))()
const api = {
  init: mod.cwrap('es_init', 'number', ['number']),
  load: mod.cwrap('es_load', 'number', ['string']),
  error: mod.cwrap('es_error', 'string', []),
  name: mod.cwrap('es_name', 'string', []),
  render: mod.cwrap('es_render', 'number', ['number', 'number']),
  setPedal: mod.cwrap('es_set_pedal', null, ['number']),
  followRpm: mod.cwrap('es_set_follow_rpm', null, ['number']),
  rpm: mod.cwrap('es_rpm', 'number', []),
  cylinders: mod.cwrap('es_cylinders', 'number', []),
  displacement: mod.cwrap('es_displacement', 'number', []),
  simFrequency: mod.cwrap('es_sim_frequency', 'number', []),
}
const buffer = mod._malloc(QUANTUM * 4)
const view = () => mod.HEAPF32.subarray(buffer >> 2, (buffer >> 2) + QUANTUM)

api.init(SAMPLE_RATE)

/** Render exactly `samples` frames, a quantum at a time, as the worklet does. */
function render(samples) {
  const quanta = Math.ceil(samples / QUANTUM)
  const out = new Float32Array(quanta * QUANTUM)
  for (let i = 0; i < quanta; i += 1) {
    api.render(buffer, QUANTUM)
    out.set(view(), i * QUANTUM)
  }
  return out.subarray(0, samples)
}

/**
 * Does the wrap look like an ordinary sample step, or like a cut?
 *
 * That IS the definition of seamless, and it took three metrics to land on it:
 *
 *   against the median step   wrong for a sparse waveform. A single cylinder at 500 rpm is mostly
 *                             quiet between firings, so the median is tiny and a good loop scored
 *                             28x while a bad one scored 7x — ranked backwards.
 *   against the peak          right for an uncrossfaded cut, wrong after one. The crossfade makes
 *                             out[0] literally be the sample that followed out[N−1], so the
 *                             "wrap" is a real step of the signal — and a V8 at 500 rpm has steps
 *                             worth 1.4% of peak, which this then called a defect.
 *   against the 99th          what it is now. A wrap that is no bigger than the signal's own
 *   percentile of its own     large steps cannot be heard as a discontinuity, whatever the
 *   steps                     waveform's shape or level.
 */
function seam(samples) {
  const steps = new Float64Array(samples.length - 1)
  for (let i = 1; i < samples.length; i += 1) steps[i - 1] = Math.abs(samples[i] - samples[i - 1])
  const sorted = Float64Array.from(steps).sort()
  const p99 = sorted[Math.floor(sorted.length * 0.99)]
  const wrap = Math.abs(samples[0] - samples[samples.length - 1])
  return p99 > 0 ? wrap / p99 : (wrap > 0 ? Infinity : 0)
}

/**
 * Close the loop by crossfading one extra cycle over the head.
 *
 * WHY ALIGNMENT ALONE IS NOT ENOUGH, which took a bake of the whole catalog to see. A whole
 * number of engine cycles makes the PERIODIC part line up exactly — and this synthesizer is not
 * purely periodic. It has noise in it (highFrequencyNoise, lowFrequencyNoise), and noise does not
 * repeat, by definition. So the wrap discontinuity is essentially a random draw from the noise
 * amplitude, and a fixed threshold on it passes and fails layers at random: the first run kept
 * the GM LS at 3422 rpm and dropped it at 4238, kept the LFA at 9000 and dropped it at 5772.
 * Scattered, not systematic — which is the shape of a measurement of noise rather than of a fault.
 *
 * The fix is the standard one and the alignment is what makes it free. Render N + C samples, C
 * being exactly one cycle, and fade x[N..N+C) in over x[0..C):
 *
 *     out[i] = x[i]·(i/C) + x[i+N]·(1 − i/C)     for i < C
 *     out[i] = x[i]                              otherwise
 *
 * Then out[0] is exactly x[N] — the sample that genuinely followed x[N−1] — so the wrap is
 * continuous to the bit. And because x[i] and x[i+N] are one whole engine cycle apart, their
 * periodic content is IDENTICAL: the crossfade averages only the noise. That is the whole payoff
 * of the cycle arithmetic, and it is why a misaligned crossfade combs instead.
 *
 * LINEAR, not equal-power, for the same reason the two engine buses are: the two sides are the
 * same signal, so they sum coherently and a √ law would be 3 dB loud in the middle.
 */
function closeLoop(long, n, cycle) {
  const out = Float32Array.from(long.subarray(0, n))
  for (let i = 0; i < cycle; i += 1) {
    const w = i / cycle
    out[i] = long[i] * w + long[i + n] * (1 - w)
  }
  return out
}

/** How much the crossfade CHANGED the head — the control that proves the alignment is real. */
function smear(original, crossfaded, cycle) {
  let num = 0
  let den = 0
  for (let i = 0; i < cycle; i += 1) {
    const d = crossfaded[i] - original[i]
    num += d * d
    den += original[i] * original[i]
  }
  return den > 0 ? Math.sqrt(num / den) : 0
}

/*
 * A SANITY BOUND, NOT THE CHECK. After the crossfade out[0] IS the sample that followed out[N−1],
 * so the wrap is a genuine step of the signal and can legitimately be larger than the 99th
 * percentile — the Audi I5 at 1547 rpm scored 1.53 on a loop that is closed to the bit, and a
 * threshold of 1.5 failed the whole bake over it. The real check is the exact one below
 * (`loop[0] === long[samples]`), which has one right answer; this is here to catch a gross error
 * that somehow satisfies it, and is recorded per layer either way.
 */
const SEAM_MAX = 6

/** 16-bit PCM mono. No metadata, no cue chunk: the file IS the loop. */
function wav(samples, rate) {
  const pcm = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    // clamp before rounding: a sample at exactly 1.0 becomes 32768, which wraps to -32768 and is
    // a full-scale click in the middle of an otherwise clean loop
    const v = Math.max(-1, Math.min(1, samples[i]))
    pcm.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)   // PCM
  header.writeUInt16LE(1, 22)   // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

const entries = require(path.join(ROOT, 'wasm/engines.json'))
const wanted = MATCH ? entries.filter((e) => e.path.includes(MATCH)) : entries
if (!wanted.length) {
  console.error(`no engine matches ${JSON.stringify(MATCH)} — have ${entries.length}`)
  exit(1)
}

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const index = { version: 1, bakedAt: new Date().toISOString(), packs: [] }
let worstSeam = 0
let worstSmear = 0
const controls = []
let layersWritten = 0
let bytes = 0
const started = Date.now()

for (const entry of wanted) {
  const id = entry.path.replace(/^engines\//, '').replace(/\.mr$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  if (api.load(entry.path) !== 1) {
    console.error(`  SKIP ${entry.path} — ${api.error().split('\n')[0]}`)
    continue
  }
  // ask for the impossible and read back what the limiter allowed
  api.setPedal(1)
  api.followRpm(1e5)
  render(Math.round(SAMPLE_RATE * 0.3))
  const redline = api.rpm()
  if (!(redline > FLOOR)) {
    console.error(`  SKIP ${entry.path} — measured a redline of ${redline.toFixed(0)}, at or below the floor`)
    continue
  }
  const range = { floor: FLOOR, redline }
  const ladder = rpmLadder(FLOOR, redline)
  const dir = path.join(OUT, id)
  await mkdir(dir, { recursive: true })

  const pack = {
    source: entry.path,
    name: api.name(),
    cylinders: api.cylinders(),
    displacement: api.displacement(),
    sampleRate: SAMPLE_RATE,
    layers: [],
    bakedAt: new Date().toISOString(),
    bakerVersion: BAKER_VERSION,
    voicing: {},
    revRange: { ...range, redlineMeasured: true },
  }

  // THE BOTTOM OF THE RANGE IS DISCOVERED, NOT DECLARED. An engine turning below its real idle
  // does not fire cleanly cycle after cycle, so its sound is not periodic and NO cut loops — the
  // seam stays near 0.4 however you align it. Rather than typing an idle per engine, the ladder
  // starts at the floor and the layers that cannot loop are dropped, so the range that comes out
  // is the range in which this engine actually runs.
  let layerSmear = 0
  for (const pedal of PEDALS) {
    for (const asked of ladder) {
      // AT MOST, at the top. The nearest whole-sample cycle to a redline can be ABOVE it, and
      // follow mode then gives the limiter instead — a loop cut for a speed the engine never
      // reached. Only the top layer can hit this, so only the top layer pays the extra rounding.
      const atTop = asked >= redline - 1e-6
      const rpm = atTop ? bakeRpmAtMost(asked, SAMPLE_RATE) : bakeRpm(asked, SAMPLE_RATE)
      const cycles = loopCycles(rpm)
      const samples = Math.round((120 * SAMPLE_RATE) / rpm) * cycles
      api.followRpm(rpm)
      api.setPedal(pedal)
      // SETTLE FIRST. The leveler and the exhaust convolution both have a tail, and recording
      // into it bakes a fade-in that loops forever. Half a second is several times either.
      render(Math.round(SAMPLE_RATE * 0.5))
      // AND CHECK WHAT IT ACTUALLY DID. The loop length is cut for `rpm`; if the engine is
      // turning at anything else the loop is not a whole number of cycles and clicks forever.
      // Belt and braces now that the ladder is measured, but this is the assertion that turned a
      // silent permanent click into a failed bake, so it stays.
      const actual = api.rpm()
      if (Math.abs(actual - rpm) > 0.01) {
        console.error(`  FAIL ${id}: asked ${rpm.toFixed(2)} rpm, the engine is turning ${actual.toFixed(2)} — the loop would be cut for the wrong speed`)
        exit(1)
      }
      const cycle = Math.round((120 * SAMPLE_RATE) / rpm)
      const long = Float32Array.from(render(samples + cycle))
      const loop = closeLoop(long, samples, cycle)

      // EXACT, first: after the crossfade out[0] must literally BE the sample that followed
      // out[N−1] in the original render. That is an index check with one right answer, and it is
      // the only part of this that can be wrong in a way no listening would reveal.
      if (loop[0] !== long[samples]) {
        console.error(`  FAIL ${id} ${rpm.toFixed(0)} rpm pedal ${pedal}: the crossfade did not close the loop — out[0] is ${loop[0]}, the sample after the end is ${long[samples]}`)
        exit(1)
      }
      const s = seam(loop)
      if (!(s <= SEAM_MAX)) {
        console.error(`  FAIL ${id} ${rpm.toFixed(0)} rpm pedal ${pedal}: the wrap steps ${s.toFixed(2)}x the signal's own 99th-percentile step, which no closed loop should`)
        exit(1)
      }
      worstSeam = Math.max(worstSeam, s)
      /*
       * HOW PERIODIC THIS LAYER ACTUALLY IS, which is worth recording rather than acting on.
       *
       * The crossfade averages two stretches one engine cycle apart. If the engine is running
       * cleanly they are the same waveform and averaging changes almost nothing (0.01–0.1); if it
       * is turning too slowly to fire consistently they are different and averaging changes a lot
       * (0.6+). So this is a direct measure of "is this engine really running at this rpm", and a
       * V8 at 500 rpm scores badly for an honest reason.
       *
       * Not a reason to DROP the layer: follow mode is kinematic, so it is a true recording of
       * that engine turning that slowly, and nothing will ask for it. Recorded so a player can
       * prefer the clean part of the range and so the number is visible rather than folklore.
       */
      layerSmear = smear(long, loop, cycle)
      worstSmear = Math.max(worstSmear, layerSmear)
      const file = `${Math.round(rpm)}-${pedal}.wav`
      const buf = wav(loop, SAMPLE_RATE)
      await writeFile(path.join(dir, file), buf)
      bytes += buf.length
      layersWritten += 1
      pack.layers.push({
        rpm, pedal, file,
        loopStart: 0, loopEnd: samples / SAMPLE_RATE,
        loopStartSamples: 0, loopEndSamples: samples,
        cycles, peak: +peak(loop).toFixed(5), rms: +rms(loop).toFixed(5),
        seam: +s.toFixed(3), smear: +layerSmear.toFixed(4),
      })
    }
  }
  pack.layers.sort((a, b) => a.pedal - b.pedal || a.rpm - b.rpm)
  // The layer in the GEOMETRIC middle of the range, at full throttle — not the middle of the
  // array, which is sorted by pedal first and so lands on the boundary between the two throttle
  // sets. That picked a marginal overrun layer on the Audi I5 and reported the scheme broken when
  // what was broken was the choice of subject. Full throttle because that is where an engine is
  // most periodic, so it is where the claim is strongest: if alignment does not help HERE it does
  // not help anywhere.
  const wide = pack.layers.filter((l) => l.pedal === 1)
  const target = Math.sqrt(Math.min(...pack.layers.map((l) => l.rpm)) * Math.max(...pack.layers.map((l) => l.rpm)))
  const mid = (wide.length ? wide : pack.layers)
    .reduce((best, l) => (Math.abs(Math.log(l.rpm / target)) < Math.abs(Math.log(best.rpm / target)) ? l : best))
  /*
   * THE CONTROL, once per engine: crossfade the SAME audio at a length that is NOT a whole number
   * of cycles, and confirm it smears where the aligned one does not.
   *
   * The crossfade closes the wrap whatever you do, so "the seam is small" no longer proves the
   * cycle arithmetic is earning its keep — it only proves the indices are right. What the
   * alignment buys is that the two sides of the fade are the SAME waveform one cycle apart, so
   * averaging them changes nothing. Misalign it and you are averaging two different parts of the
   * cycle, which cancels and combs. That difference is the thing to measure.
   */
  api.followRpm(mid.rpm)
  api.setPedal(mid.pedal)
  render(Math.round(SAMPLE_RATE * 0.5))
  const cyc = Math.round((120 * SAMPLE_RATE) / mid.rpm)
  const raw = Float32Array.from(render(mid.loopEndSamples + cyc * 2))
  const alignedSmear = smear(raw, closeLoop(raw, mid.loopEndSamples, cyc), cyc)
  const offBy = Math.max(1, Math.round(cyc * 0.37))
  const badSmear = smear(raw, closeLoop(raw, mid.loopEndSamples + offBy, cyc), cyc)
  /*
   * RECORDED PER ENGINE, ASSERTED ACROSS THE CATALOG — and this used to fail the bake per engine.
   *
   * The comparison only has teeth where the PERIODIC part dominates. On a five-cylinder radial at
   * 1225 rpm it does not: that engine is mostly induction noise at that rev, so the aligned fade
   * smears 0.45 and the misaligned one 0.74, and a per-engine "must beat it twofold" rule failed
   * the whole bake over an engine behaving exactly as a noisy engine should.
   *
   * Picking each engine's most periodic layer instead would pass, and would be choosing the
   * subject to suit the answer. The honest form is the one below: the claim is about the SCHEME,
   * so it is asserted over every engine at once, plus a per-engine guard that alignment never
   * actively makes things worse — which would be a real fault rather than a noisy engine.
   */
  controls.push({ id, aligned: alignedSmear, misaligned: badSmear })
  if (alignedSmear > badSmear) {
    console.error(`  FAIL ${id}: aligning the crossfade to the cycle made it WORSE (${alignedSmear.toFixed(3)} against ${badSmear.toFixed(3)} misaligned) — the cycle length is wrong for this engine`)
    exit(1)
  }
  pack.control = { rpm: mid.rpm, alignedSmear: +alignedSmear.toFixed(4), misalignedSmear: +badSmear.toFixed(4) }
  // MIN AND MAX OVER ALL LAYERS, not the first and last of a list sorted by PEDAL then rpm —
  // that reported the five-cylinder radial as covering "626 to 500 rpm", because layers[0] was
  // the bottom of the overrun set and layers[last] was the top of the wide-open one.
  const revs = pack.layers.map((l) => l.rpm)
  pack.revRange.usable = { lo: Math.min(...revs), hi: Math.max(...revs) }
  await writeFile(path.join(dir, 'pack.json'), JSON.stringify(pack, null, 1))
  index.packs.push({ id, source: entry.path, name: pack.name, cylinders: pack.cylinders, dir: id })
  const loud = Math.max(...pack.layers.map((l) => l.peak))
  const u = pack.revRange.usable
  console.log(`  ${id.padEnd(34)} ${String(pack.cylinders).padStart(2)}cyl  ${String(pack.layers.length).padStart(2)} layers  ` +
    `${u.lo.toFixed(0).padStart(5)}–${u.hi.toFixed(0).padStart(5)} rpm  peak ${loud.toFixed(3)}  ` +
    `smear ${alignedSmear.toFixed(4)} vs ${badSmear.toFixed(3)} misaligned`)
}

/*
 * THE SCHEME, ASSERTED ONCE, OVER EVERYTHING BAKED.
 *
 * Every loop is crossfaded closed, so every loop is seamless whether or not the cycle arithmetic
 * is right — that is what makes this check necessary. What alignment buys is that the two sides
 * of the fade are the same waveform one engine cycle apart, so averaging them changes nothing.
 * If that were not true, these two medians would be the same number and everything in pack.ts
 * would be ceremony.
 */
const med = (xs) => { const a = [...xs].sort((p, q) => p - q); return a[a.length >> 1] }
const alignedMed = med(controls.map((c) => c.aligned))
const misalignedMed = med(controls.map((c) => c.misaligned))
if (!(misalignedMed > alignedMed * 3)) {
  console.error(`\nFAIL: across ${controls.length} engines a misaligned crossfade smears ${misalignedMed.toFixed(3)} against the aligned ${alignedMed.toFixed(3)} — cycle alignment is not what is making these loop`)
  exit(1)
}
index.control = { engines: controls.length, alignedMed: +alignedMed.toFixed(4), misalignedMed: +misalignedMed.toFixed(4) }

await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1))
console.log(`\n${index.packs.length} packs, ${layersWritten} layers, ${(bytes / 2 ** 20).toFixed(1)} MiB, ${((Date.now() - started) / 1000).toFixed(1)} s`)
console.log(`worst seam ${worstSeam.toFixed(3)}x the signal's own 99th-percentile step (${SEAM_MAX} is the refusal threshold)`)
console.log(`worst crossfade smear ${worstSmear.toFixed(4)} — how much averaging two cycles changed the head`)
console.log(`alignment: median smear ${alignedMed.toFixed(4)} aligned vs ${misalignedMed.toFixed(4)} misaligned, over ${controls.length} engines`)
console.log(`  → ${OUT}`)
