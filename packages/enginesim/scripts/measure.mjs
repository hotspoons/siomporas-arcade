// Does the wasm build actually make a noise, and can it do it faster than realtime on one thread?
//
// Both questions matter and neither is rhetorical. The first because upstream's emscripten path
// silently disables the legacy PCM queue — a build that drives `readAudioOutput()` compiles, runs,
// reports a perfectly believable RPM and emits digital silence. The second because `es_render()`
// runs the rigid-body solver inside the audio callback, so if a 128-frame quantum costs more than
// 128/sampleRate seconds the result is not "a bit slow", it is continuous crackle.
//
// Run: node packages/enginesim/scripts/measure.mjs [path/to/enginesim.js]

import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

const require = createRequire(import.meta.url)
const modulePath = argv[2] ?? new URL('../wasm/enginesim.cjs', import.meta.url).pathname
const SAMPLE_RATE = 48000
const QUANTUM = 128

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

const createEngineSim = require(modulePath)
const mod = await createEngineSim()

const api = {
  init: mod.cwrap('es_init', 'number', ['number']),
  load: mod.cwrap('es_load', 'number', ['string']),
  error: mod.cwrap('es_error', 'string', []),
  name: mod.cwrap('es_name', 'string', []),
  render: mod.cwrap('es_render', 'number', ['number', 'number']),
  setPedal: mod.cwrap('es_set_pedal', null, ['number']),
  setStarter: mod.cwrap('es_set_starter', null, ['number']),
  setIgnition: mod.cwrap('es_set_ignition', null, ['number']),
  followRpm: mod.cwrap('es_set_follow_rpm', null, ['number']),
  setFree: mod.cwrap('es_set_free', null, ['number', 'number', 'number']),
  setIrLimit: mod.cwrap('es_set_ir_limit', null, ['number']),
  setParam: mod.cwrap('es_set_audio_param', null, ['number', 'number']),
  rpm: mod.cwrap('es_rpm', 'number', []),
  cylinders: mod.cwrap('es_cylinders', 'number', []),
  displacement: mod.cwrap('es_displacement', 'number', []),
  simFrequency: mod.cwrap('es_sim_frequency', 'number', []),
}

const buffer = mod._malloc(QUANTUM * 4)
const view = () => mod.HEAPF32.subarray(buffer >> 2, (buffer >> 2) + QUANTUM)

/** Render `seconds` of audio one quantum at a time, as the worklet will. */
function render(seconds, onQuantum) {
  const quanta = Math.round((seconds * SAMPLE_RATE) / QUANTUM)
  const out = new Float32Array(quanta * QUANTUM)
  const started = performance.now()
  for (let i = 0; i < quanta; i += 1) {
    onQuantum?.(i / quanta)
    api.render(buffer, QUANTUM)
    out.set(view(), i * QUANTUM)
  }
  const elapsed = (performance.now() - started) / 1000
  return { out, elapsed, realtimeFactor: seconds / elapsed }
}

api.init(SAMPLE_RATE)

// THE CONTROL. Nothing is loaded, so this must be silent. Without it "the audio is not silent"
// proves nothing — a probe that cannot fail is not measuring anything.
const control = render(0.1)
check('silent before any engine is loaded', peak(control.out) === 0,
  `peak ${peak(control.out).toExponential(2)}`)

const script = 'engines/atg-video-2/07_gm_ls.mr'
const loaded = api.load(script)
check(`compiles ${script}`, loaded === 1, loaded === 1 ? api.name() : api.error().split('\n')[0])
if (loaded !== 1) exit(1)

check('reports 8 cylinders', api.cylinders() === 8, `${api.cylinders()}`)
check('reports a displacement', api.displacement() > 0,
  `${(api.displacement() * 1e6).toFixed(0)} cc`)

// Follow mode: hold a fixed RPM and listen. This is the game's path.
const idle = 900
api.followRpm(idle)
api.setPedal(0.0)
render(0.5) // settle: the leveler and the convolution tail both need a moment
const held = render(1.0)
check('follow mode holds the requested RPM', Math.abs(api.rpm() - idle) < idle * 0.15,
  `asked ${idle}, got ${api.rpm().toFixed(0)}`)
check('produces audio at idle', rms(held.out) > 1e-4, `rms ${rms(held.out).toExponential(2)}`)
check('audio is not clipped to silence or DC', peak(held.out) > rms(held.out) * 1.5,
  `peak ${peak(held.out).toFixed(3)} rms ${rms(held.out).toFixed(4)}`)

// The firing frequency should land where eight cylinders at this RPM put it. This is the check
// that the audio is THIS ENGINE rather than any old noise: a V8 at 900 rpm fires at 60 Hz.
function dominantHz(samples, lo, hi) {
  let best = 0
  let bestHz = 0
  for (let hz = lo; hz <= hi; hz += 0.25) {
    let re = 0
    let im = 0
    const w = (2 * Math.PI * hz) / SAMPLE_RATE
    for (let i = 0; i < samples.length; i += 1) {
      re += samples[i] * Math.cos(w * i)
      im += samples[i] * Math.sin(w * i)
    }
    const mag = Math.hypot(re, im)
    if (mag > best) { best = mag; bestHz = hz }
  }
  return bestHz
}

const expectedHz = (idle * api.cylinders()) / 120
const foundHz = dominantHz(held.out.subarray(0, SAMPLE_RATE / 2), expectedHz - 20, expectedHz + 20)
check('dominant tone is the firing frequency', Math.abs(foundHz - expectedHz) < 4,
  `expected ${expectedHz.toFixed(1)} Hz, found ${foundHz.toFixed(1)} Hz`)

// Pedal must change the sound, or the ECS binding has nothing to bind to.
api.setPedal(1.0)
render(0.4)
const open = render(1.0)
check('opening the pedal changes the output level', rms(open.out) !== rms(held.out),
  `closed ${rms(held.out).toExponential(2)} open ${rms(open.out).toExponential(2)}`)

// Sweep, both for the realtime number under a moving load and for something listenable.
api.setPedal(0.85)
const SWEEP_SECONDS = 6
const sweep = render(SWEEP_SECONDS, (t) => api.followRpm(800 + t * (6500 - 800)))
check('rpm sweep reaches the top', api.rpm() > 5500, `${api.rpm().toFixed(0)} rpm`)
check('sweep audio is continuous', rms(sweep.out) > 1e-4, `rms ${rms(sweep.out).toExponential(2)}`)

console.log('')
console.log(`  simulation frequency   ${api.simFrequency()} Hz`)
console.log(`  sweep realtime factor  ${sweep.realtimeFactor.toFixed(2)}x  ` +
  `(${(sweep.elapsed / SWEEP_SECONDS * 100).toFixed(1)}% of one core)`)
console.log(`  budget per 128 frames  ${(QUANTUM / SAMPLE_RATE * 1000).toFixed(2)} ms, ` +
  `using ${(sweep.elapsed / (SWEEP_SECONDS * SAMPLE_RATE / QUANTUM) * 1000).toFixed(2)} ms`)

check('beats realtime with headroom', sweep.realtimeFactor > 2,
  `${sweep.realtimeFactor.toFixed(2)}x`)

// THE COST CURVE. `es_set_ir_limit` trims the exhaust convolution, which is where nearly all the
// CPU goes, so this is the dial that decides whether the game can afford an engine at all. Measure
// it rather than guessing a default: report what each setting costs AND how far its output drifts
// from the full-fidelity one, so the choice is a trade with both sides visible.
console.log('\n  convolution tail    cost         spectral difference vs 10000 taps')
const reference = { spectrum: null }
const bands = (samples) => {
  // Coarse third-octave energy from 50 Hz up; enough to see a tail being cut, cheap enough to run.
  const out = []
  for (let hz = 50; hz < 12000; hz *= 2 ** (1 / 3)) {
    let re = 0
    let im = 0
    const w = (2 * Math.PI * hz) / SAMPLE_RATE
    for (let i = 0; i < samples.length; i += 1) {
      re += samples[i] * Math.cos(w * i)
      im += samples[i] * Math.sin(w * i)
    }
    out.push(Math.hypot(re, im) / samples.length)
  }
  return out
}

for (const taps of [10000, 4096, 2048, 1024, 512]) {
  api.setIrLimit(taps)
  api.load(script)
  api.followRpm(3000)
  api.setPedal(0.6)
  render(0.6)
  const run = render(2.0)
  const spectrum = bands(run.out.subarray(0, SAMPLE_RATE / 2))
  reference.spectrum ??= spectrum
  // Mean absolute difference in dB across the bands, which tracks audible timbre change far better
  // than a sample-wise comparison: the simulation is stochastic, so waveforms never line up.
  const drift = spectrum.reduce((sum, value, i) => {
    const a = Math.max(value, 1e-9)
    const b = Math.max(reference.spectrum[i], 1e-9)
    return sum + Math.abs(20 * Math.log10(a / b))
  }, 0) / spectrum.length
  console.log(`  ${String(taps).padStart(5)} taps         ${run.realtimeFactor.toFixed(2)}x  ` +
    `${((1 / run.realtimeFactor) * 100).toFixed(0).padStart(3)}% of a core     ${drift.toFixed(2)} dB`)
}
// Write it out so a human can listen rather than trusting the numbers.
const wavPath = new URL('../../../shots/enginesim-sweep.wav', import.meta.url).pathname
const pcm = Buffer.alloc(sweep.out.length * 2)
for (let i = 0; i < sweep.out.length; i += 1) {
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sweep.out[i] * 32767))), i * 2)
}
const header = Buffer.alloc(44)
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8)
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20)
header.writeUInt16LE(1, 22); header.writeUInt32LE(SAMPLE_RATE, 24)
header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
header.write('data', 36); header.writeUInt32LE(pcm.length, 40)
writeFileSync(wavPath, Buffer.concat([header, pcm]))
console.log(`\n  wrote ${wavPath}`)

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`)
  exit(1)
}
console.log('all checks passed')
