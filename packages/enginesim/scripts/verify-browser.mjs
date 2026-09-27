// Prove the engine runs in a real browser audio thread.
//
// scripts/measure.mjs answers "does the simulation work" in Node, where the wasm has a full libc, a
// filesystem and every global it wants. It cannot answer the question this package actually rests
// on: an AudioWorkletGlobalScope has no fetch, no XMLHttpRequest, no document and in Chrome no
// `performance`, and Emscripten's glue is written for pages. If any of that bites, the symptom is
// not an exception you see — it is a node that outputs zeroes forever.
//
// So this drives headless Chromium through a real AudioContext, captures what the node actually
// emits, and checks the firing frequency is the one an engine of that many cylinders makes at that
// RPM. Silence before loading is captured too, as the control that gives the rest its meaning.
//
//   node packages/enginesim/scripts/verify-browser.mjs

import { createServer } from 'vite'
import { chromium } from 'playwright'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(packageRoot, '..', '..')

const SCRIPT = 'engines/atg-video-2/07_gm_ls.mr'
const RPM = 2400
const SECONDS = 1.5

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const server = await createServer({
  root: repoRoot,
  server: { port: 5199, strictPort: false },
  logLevel: 'error',
})
await server.listen()
const port = server.config.server.port ?? server.httpServer.address().port
const url = `http://localhost:${port}/packages/enginesim/scripts/verify.html`

const browser = await chromium.launch({
  args: [
    // Headless Chromium has no sound card. This gives Web Audio a silent device that still runs the
    // rendering thread at realtime, which is the whole point: we are testing the audio thread.
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream',
    '--mute-audio',
  ],
})

try {
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction('window.verificationReady === true', { timeout: 30_000 })

  const result = await page.evaluate(
    (args) => window.runVerification(args),
    { script: SCRIPT, rpm: RPM, seconds: SECONDS })

  check('no page or worklet errors', consoleErrors.length === 0 && result.errors.length === 0,
    [...consoleErrors, ...result.errors][0] ?? '')
  check('wasm instantiated inside the AudioWorklet', result.profile?.cylinders === 8,
    `${result.profile?.name}, ${result.profile?.cylinders} cylinders`)

  // The control first: if this were non-zero the "makes a sound" check below would prove nothing.
  check('silent before an engine is loaded', result.silencePeak === 0,
    `peak ${result.silencePeak.toExponential(2)} over ${result.silenceSamples} samples`)

  check('the node emits audio', result.audioRms > 1e-4,
    `rms ${result.audioRms.toExponential(2)}, peak ${result.audioPeak.toFixed(3)}`)
  // Not clipping. The synthesizer saturates in the int16 domain before we ever see a float, so a
  // peak pinned at exactly 1.0 is not "loud", it is a squared-off waveform nothing downstream can
  // recover. This is the check that the default volume is doing its job.
  check('output is not clipping', result.audioPeak < 0.99,
    `peak ${result.audioPeak.toFixed(3)}, rms ${result.audioRms.toFixed(3)}`)
  check('captured roughly the expected duration',
    Math.abs(result.audioSamples / result.sampleRate - SECONDS) < SECONDS * 0.5,
    `${(result.audioSamples / result.sampleRate).toFixed(2)}s`)

  // Continuous audio, not a buffer that ran dry: an underrunning worklet shows up as runs of exact
  // zeroes where renderRealtimeAudio found nothing in the ring.
  const audio = result.audio
  let longestZeroRun = 0
  let run = 0
  for (const sample of audio) {
    run = sample === 0 ? run + 1 : 0
    if (run > longestZeroRun) longestZeroRun = run
  }
  check('no audio-thread underruns', longestZeroRun < 128,
    `longest silent run ${longestZeroRun} samples`)

  // And the decisive one: is this THIS engine? A V8 at 2400 rpm fires at 160 Hz.
  const expectedHz = (RPM * result.profile.cylinders) / 120
  let best = 0
  let bestHz = 0
  for (let hz = expectedHz - 25; hz <= expectedHz + 25; hz += 0.25) {
    let re = 0
    let im = 0
    const w = (2 * Math.PI * hz) / result.sampleRate
    for (let i = 0; i < audio.length; i += 1) {
      re += audio[i] * Math.cos(w * i)
      im += audio[i] * Math.sin(w * i)
    }
    const magnitude = Math.hypot(re, im)
    if (magnitude > best) { best = magnitude; bestHz = hz }
  }
  check('dominant tone is the firing frequency', Math.abs(bestHz - expectedHz) < 5,
    `expected ${expectedHz.toFixed(1)} Hz, found ${bestHz.toFixed(1)} Hz`)

  check('telemetry came back from the audio thread',
    Math.abs(result.telemetry.rpm - RPM) < RPM * 0.2,
    `reported ${result.telemetry.rpm.toFixed(0)} rpm`)
} finally {
  await browser.close()
  await server.close()
}

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('all checks passed in a real browser audio thread')
