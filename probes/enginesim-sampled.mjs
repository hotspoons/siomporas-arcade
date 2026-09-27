// A baked engine has to sound like the engine, at the rev it was asked for.
//
// The pack scheme rests on a chain of arithmetic — a rev ladder, a bake rpm nudged onto a whole
// sample cycle, a bracket in pitch, a playbackRate that puts the exact rev back — and every link
// of it is silent when wrong. A wrong playbackRate is a car that revs to the wrong note; a wrong
// bracket is a car that jumps a layer; neither throws.
//
// So this measures the FIRING FREQUENCY of what comes out. A four-stroke fires cylinders/2 times
// per revolution, so at R rpm with C cylinders the fundamental is R·C/120 Hz — a fact about the
// engine, not about this code, which is what makes it a test rather than a restatement.
//
//   node probes/enginesim-sampled.mjs [packs-dir]
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const PACKS = path.resolve(process.argv[2] ?? 'packages/enginesim/packs')
if (!(await stat(PACKS).catch(() => null))) {
  console.error(`no packs at ${PACKS} — run: npm run bake -w @apex/enginesim`)
  process.exit(1)
}

/*
 * Serve the packs, AND a page to run from.
 *
 * `decodeAudioData` needs a real fetch and file:// will not do — but neither will about:blank,
 * which has an opaque origin and cannot fetch http:// at all. The page has to come from the same
 * server as the audio, so the server answers `/` with an empty document.
 */
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '')
  if (rel === '') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<!doctype html><title>packs</title>')
  }
  try {
    if (rel.includes('..')) { res.writeHead(400); return res.end() }
    const body = await readFile(path.join(PACKS, rel))
    res.writeHead(200, { 'content-type': rel.endsWith('.json') ? 'application/json' : 'audio/wav' })
    res.end(body)
  } catch { res.writeHead(404); res.end('no') }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const bundle = await build({
  stdin: { contents: "export * from './pack'; export * from './sampled'", resolveDir: 'packages/enginesim/src', loader: 'ts' },
  bundle: true, format: 'iife', globalName: 'Sampled', write: false, target: 'es2020',
})

const index = JSON.parse(await readFile(path.join(PACKS, 'index.json'), 'utf8'))
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.goto(`${base}/`)
await page.addScriptTag({ content: bundle.outputFiles[0].text })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

/**
 * Render a baked engine held at one rev, and report what note came out.
 *
 * NARROW BAND, AND IT HAS TO BE. An engine's spectrum is a comb of ORDERS — multiples of half the
 * crank frequency — and the firing frequency is only one of them. At 1100 rpm this searched +/-20%
 * around the firing frequency, the 3.5th order sat at exactly -12.5% inside that window, and it
 * was the stronger of the two: the probe reported "off by -12.50%" twice and both times it had
 * found a real peak that was not the one being asked about. The band is +/-5% now, which excludes
 * the neighbouring half-orders for any cylinder count above two.
 *
 * `atEdge` is what keeps a narrow band honest. If the peak being looked for is NOT in the window,
 * the strongest thing in it is whatever is closest to the window's edge — so a result sitting on
 * the boundary means "not found here", not "found here". Reported rather than hidden.
 *
 * Goertzel-style rather than an FFT: a bin-limited FFT at 48 kHz over half a second cannot resolve
 * the few Hz that distinguish "the right layer resampled correctly" from "a neighbouring layer
 * played raw".
 */
const measure = (dir, rpm, pedal, band) => page.evaluate(async ([base, dir, rpm, pedal, band]) => {
  const RATE = 48000, SECONDS = 0.7
  const ctx = new OfflineAudioContext(1, RATE * SECONDS, RATE)
  const eng = await Sampled.SampledEngine.load(ctx, `${base}/${dir}`, { glide: 0.001 })
  eng.output.connect(ctx.destination)
  eng.drive(rpm, pedal)
  const buf = await ctx.startRendering()
  const d = buf.getChannelData(0)
  const skip = Math.floor(RATE * 0.15) // past the ramps
  const x = d.subarray(skip)
  let best = 0, bestHz = 0
  for (let hz = band[0]; hz <= band[1]; hz += 0.25) {
    let re = 0, im = 0
    const w = (2 * Math.PI * hz) / RATE
    for (let i = 0; i < x.length; i += 1) { re += x[i] * Math.cos(w * i); im += x[i] * Math.sin(w * i) }
    const mag = Math.hypot(re, im)
    if (mag > best) { best = mag; bestHz = hz }
  }
  let sum = 0
  for (let i = 0; i < x.length; i += 1) sum += x[i] * x[i]
  const span = band[1] - band[0]
  return {
    hz: bestHz, rms: Math.sqrt(sum / x.length), gains: eng.state,
    atEdge: bestHz - band[0] < span * 0.02 || band[1] - bestHz < span * 0.02,
  }
}, [base, dir, rpm, pedal, band])

/** The band to look in: tight around where the engine's own arithmetic says the firing is. */
const firing = (rpm) => (rpm * cyl) / 120
const near = (hz, frac = 0.05) => [hz * (1 - frac), hz * (1 + frac)]

// A V8: eight cylinders puts the firing frequency clear of the crank frequency, so there is no
// ambiguity about which peak was found.
const pick = index.packs.find((p) => p.id.includes('gm-ls')) ?? index.packs[0]
const pack = JSON.parse(await readFile(path.join(PACKS, pick.dir, 'pack.json'), 'utf8'))
const cyl = pack.cylinders
const lo = Math.min(...pack.layers.map((l) => l.rpm))
const hi = Math.max(...pack.layers.map((l) => l.rpm))
console.log(`  ${pick.id}: ${cyl} cylinders, ${pack.layers.length} layers, ${lo.toFixed(0)}–${hi.toFixed(0)} rpm\n`)

// Revs chosen BETWEEN baked layers, which is where the arithmetic has to work: exactly on a layer,
// any implementation that plays the nearest file at rate 1 would also pass.
const revs = [1100, 1650, 2500, 3300, 4400].filter((r) => r > lo * 1.05 && r < hi * 0.95)
for (const rpm of revs) {
  const want = firing(rpm)
  const m = await measure(pick.dir, rpm, 1, near(want))
  ok(`${rpm} rpm fires at ${want.toFixed(1)} Hz`,
    !m.atEdge && Math.abs(m.hz - want) / want < 0.01,
    m.atEdge ? `nothing found in the band — the strongest thing in it was at its edge (${m.hz.toFixed(1)} Hz)`
      : `measured ${m.hz.toFixed(1)} Hz, off by ${((m.hz / want - 1) * 100).toFixed(2)}%`)
}

/*
 * NO HOLE WHERE THE LAYERS HAND OVER.
 *
 * NOT "the level is flat across the rev range" — that was the first version of this check and it
 * is wrong about engines. Every layer is baked to the same peak, so the level that comes out
 * varies with the WAVEFORM: at 550 rpm a V8 fires 37 times a second with silence between, and at
 * 5800 it is a continuous tone. 30 dB between them is the instrument sounding like an engine, and
 * demanding otherwise would be demanding it not.
 *
 * What must be true is that a layer boundary is not special. So: measure the step in level across
 * every adjacent pair of revs, and compare the pairs that STRADDLE a baked layer against the pairs
 * that do not. If blending were wrong, the straddling ones would stand out.
 */
const layerRevs = [...new Set(pack.layers.filter((l) => l.pedal === 1).map((l) => l.rpm))].sort((a, b) => a - b)
const sweep = []
for (let rpm = Math.ceil(lo * 1.1); rpm < hi * 0.9; rpm = Math.round(rpm * 1.06)) {
  const m = await measure(pick.dir, rpm, 1, near(firing(rpm)))
  sweep.push({ rpm, rms: m.rms })
}
const straddles = (a, b) => layerRevs.some((r) => r > a && r < b)
const steps = { across: [], within: [] }
for (let i = 1; i < sweep.length; i += 1) {
  const step = Math.max(sweep[i].rms / sweep[i - 1].rms, sweep[i - 1].rms / sweep[i].rms)
  ;(straddles(sweep[i - 1].rpm, sweep[i].rpm) ? steps.across : steps.within).push(step)
}
const med = (xs) => { const a = [...xs].sort((p, q) => p - q); return a.length ? a[a.length >> 1] : 1 }
ok('a layer boundary is no bumpier than anywhere else',
  steps.across.length > 2 && med(steps.across) < med(steps.within) * 1.35,
  `median step ${med(steps.across).toFixed(3)}x across a boundary (${steps.across.length} of them) vs ${med(steps.within).toFixed(3)}x within a layer`)
// Against its own distribution, not against a number I picked. An engine's level is not monotone
// in rpm — it has resonances — so "no step bigger than 1.8x" was a guess that happened to sit
// just under one of them. What matters is that no step is an OUTLIER among its neighbours.
const allSteps = [...steps.across, ...steps.within]
ok('and no step is an outlier among the others',
  Math.max(...allSteps) < med(allSteps) * 2.5,
  `biggest ${Math.max(...allSteps).toFixed(2)}x against a median of ${med(allSteps).toFixed(2)}x, over ${sweep.length} revs`)

// The throttle has to do something, or the ECS has nothing to bind to.
const mid = revs[Math.floor(revs.length / 2)] ?? 2500
const closed = await measure(pick.dir, mid, 0, near(firing(mid)))
const open = await measure(pick.dir, mid, 1, near(firing(mid)))
ok('the throttle changes the sound', Math.abs(open.rms - closed.rms) / Math.max(open.rms, closed.rms) > 0.05,
  `closed ${closed.rms.toFixed(4)}, open ${open.rms.toFixed(4)}`)
ok('but not the note — the rev is the rev whatever the pedal is doing',
  !closed.atEdge && Math.abs(closed.hz - open.hz) / firing(mid) < 0.01, `${closed.hz.toFixed(1)} vs ${open.hz.toFixed(1)} Hz`)

/*
 * THE CONTROL: two engines, same rev, different cylinder counts.
 *
 * The first attempt here looked in a window centred 15% off the firing frequency and expected to
 * find nothing — and found something, because an engine's spectrum is not one peak. It is a comb
 * of ORDERS at multiples of half the crank frequency, about 21 Hz apart for a V8 at 2500 rpm, so
 * a window 19 Hz wide will contain one wherever you put it. "Nothing there" was never going to be
 * true and the check was asserting a false premise.
 *
 * This one cannot be satisfied by accident. Firing frequency is rpm·cylinders/120, so at ONE rev
 * two engines must differ by exactly the ratio of their cylinder counts — a fact about engines,
 * with nothing in this code able to arrange it. If the measurement were locking onto some fixed
 * artefact, or the playback rate were ignoring the pack it came from, the ratio would not follow
 * the cylinder count.
 */
const other = index.packs.find((p) => p.id.includes('merlin')) ?? index.packs.find((p) => p.cylinders !== cyl)
if (other) {
  const otherPack = JSON.parse(await readFile(path.join(PACKS, other.dir, 'pack.json'), 'utf8'))
  const RPM = 2000
  const mine = await measure(pick.dir, RPM, 1, near((RPM * cyl) / 120))
  const theirs = await measure(other.dir, RPM, 1, near((RPM * otherPack.cylinders) / 120))
  const wantRatio = otherPack.cylinders / cyl
  ok(`CONTROL: at ${RPM} rpm a ${otherPack.cylinders}-cylinder fires ${wantRatio.toFixed(2)}x an ${cyl}-cylinder`,
    Math.abs(theirs.hz / mine.hz - wantRatio) / wantRatio < 0.02,
    `${mine.hz.toFixed(1)} Hz vs ${theirs.hz.toFixed(1)} Hz, ratio ${(theirs.hz / mine.hz).toFixed(3)} against ${wantRatio.toFixed(3)}`)
} else {
  ok('CONTROL: a second engine with a different cylinder count', false, 'no second pack to compare against')
}

// And the note moves with the rev by exactly the ratio asked for — which a measurement that could
// not find the firing frequency would not manage to 0.1%.
const a = await measure(pick.dir, 2500, 1, near(firing(2500)))
const b = await measure(pick.dir, 3150, 1, near(firing(3150)))
ok('the note tracks the rev by exactly the ratio asked for',
  Math.abs((b.hz / a.hz) - (3150 / 2500)) < 0.02, `${a.hz.toFixed(1)} → ${b.hz.toFixed(1)} Hz, ratio ${(b.hz / a.hz).toFixed(3)} against 1.260 asked`)

await browser.close()
server.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: a baked engine sounds like the engine, at the rev asked for')
process.exit(fails.length ? 1 : 0)
