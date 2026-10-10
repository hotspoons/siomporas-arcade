// Does the presets manager work in the page, not just in the unit tests?
//
// presets.test.ts proves the library and the animator against a fake tuning store. Three things
// it cannot see, and each has bitten something in this codebase before:
//
//   1. the GROUND STATE is computed from the documents, so it must not pick up whatever this
//      browser had restored into the panel before the site loaded;
//   2. a tween has to REACH THE RENDERER — the knobs moving while the sky does not is a tween only
//      the sliders can see, and that is exactly what happens if the per-frame hook is missing;
//   3. the tab has to be in the panel at all.
//
// `window.corridor` and not `window.__apex`: the rich probe surface is the former, and __apex is
// the dev bridge's much smaller context. Both exist on a bridge server and only one has `tune`.
//
//   node probes/corridor-presets.mjs
import { chromium } from 'playwright'

const url = process.env.PROBE_URL ?? 'http://localhost:5185/#arrowhead-farms?lite'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForFunction(() => !!window.corridor?.presets, null, { timeout: 60000 })

const fail = []
const say = (label, v) => console.log(`${label.padEnd(34)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

// 1. the library is there and knows which knobs it may carry
const shape = await page.evaluate(() => {
  const p = window.corridor.presets
  return { knobs: p.knobs.length, ground: Object.keys(p.ground).length, presets: p.list().length }
})
say('world knobs', shape.knobs)
say('ground state knobs', shape.ground)
if (shape.knobs < 100) fail.push(`only ${shape.knobs} world knobs — the scope flags did not reach the build`)
if (shape.ground < 100) fail.push(`ground state holds ${shape.ground} knobs, expected every world knob`)

// 2. THE GROUND STATE IGNORES THE PANEL. Move a knob, reload, and it must be unchanged: the
//    ground state is the documents, not what this browser was last playing with.
const ground = await page.evaluate(() => {
  const a = window.corridor
  const before = a.presets.ground.WEATHER_RATE
  a.tune.set('WEATHER_RATE', 3.15) // persisted to localStorage by the panel
  return { before, live: a.tune.get('WEATHER_RATE') }
})
say('WEATHER_RATE moved to', ground.live)
await page.reload({ waitUntil: 'networkidle' })
await page.waitForFunction(() => !!window.corridor?.presets, null, { timeout: 60000 })
const after = await page.evaluate(() => ({
  live: window.corridor.tune.get('WEATHER_RATE'),
  ground: window.corridor.presets.ground.WEATHER_RATE,
}))
say('after reload: live / ground', after)
if (Math.abs(after.live - 3.15) > 1e-6) fail.push('the panel did not restore the moved knob, so this test proves nothing')
if (Math.abs(after.ground - 3.15) < 1e-6) fail.push('the ground state picked up a value from the panel — it must come from the documents')

// 3. a tween moves the knobs over time and lands, and the renderer follows it
//
//    OVER TWO MINUTES, not two seconds. This page runs at about 0.4 fps under SwiftShader, so a
//    frame is ~2.5 s of real time and a two-second tween completes in ONE tick — which looks
//    exactly like the bug this is here to catch. The duration has to be long against the frame
//    time, and progress is read by polling rather than by sleeping a fixed wall-clock amount.
const tween = await page.evaluate(async () => {
  const a = window.corridor
  a.presets.put({ id: 'probe-dusk', name: 'probe dusk', values: { WEATHER: 1, WEATHER_RATE: 1.5 } })
  a.tune.set('WEATHER', 0)
  a.tune.set('WEATHER_RATE', 0.5)
  const start = { weather: a.tune.get('WEATHER'), rate: a.tune.get('WEATHER_RATE') }
  const r = a.preset('probe-dusk', { over: 120 })
  const seen = []
  for (let i = 0; i < 20 && seen.length < 3; i += 1) {
    await new Promise((res) => requestAnimationFrame(() => res(null)))
    const t = a.presets.active?.t ?? null
    if (t !== null && t > 0) seen.push([+t.toFixed(5), a.tune.get('WEATHER_RATE'), a.tune.get('WEATHER')])
  }
  const mid = { t: a.presets.active?.t ?? null, rate: a.tune.get('WEATHER_RATE'), weather: a.tune.get('WEATHER') }
  a.presets.active?.cancel()

  // landing is its own question, and a tween short against one frame answers it in one tick
  a.tune.set('WEATHER_RATE', 0.03)
  a.presets.put({ id: 'probe-land', values: { WEATHER_RATE: 0.3, WEATHER: 1 } })
  a.preset('probe-land', { over: 0.001 })
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(null))))
  const end = { rate: a.tune.get('WEATHER_RATE'), weather: a.tune.get('WEATHER'), active: !!a.presets.active }
  return { stepped: r?.stepped ?? null, start, seen, mid, end }
})
say('stepped knobs named', tween.stepped)
say('progress samples (t, rate, W)', tween.seen)
say('landed at', tween.end)
if (tween.seen.length < 2) fail.push('the transition never advanced over several frames — nothing is calling presets.tick()')
for (const [t, rate] of tween.seen) {
  if (!(t > 0 && t < 1)) fail.push(`progress reported ${t}, which is not mid-transition`)
  if (!(rate > 0.5 - 1e-9 && rate < 1.5 + 1e-9)) fail.push(`WEATHER_RATE reached ${rate}, outside the 0.5 → 1.5 it was tweening between`)
}
// NOT QUANTISED. WEATHER_RATE's slider step is 0.05; through the panel's ordinary setter the
// browser snaps a programmatic write to that grid and a "smooth" tween moves in twenty jumps.
// Every sample landing on a multiple of the step is the signature of that bug.
if (tween.seen.length >= 2 && tween.seen.every(([, rate]) => Math.abs(rate / 0.05 - Math.round(rate / 0.05)) < 1e-9)) {
  fail.push(`every sample sits on the 0.05 slider grid (${tween.seen.map((x) => x[1]).join(', ')}) — the tween is going through the quantising setter`)
}
// a step knob must not be interpolated, and before the midpoint it has not moved at all
if (tween.mid.t !== null && tween.mid.t < 0.5 && tween.mid.weather !== 0) {
  fail.push(`the step knob moved to ${tween.mid.weather} at t=${tween.mid.t}, before the midpoint`)
}
if (Math.abs(tween.end.rate - 0.3) > 1e-12) fail.push(`the tween landed on ${tween.end.rate}, not exactly 0.3`)
if (tween.end.weather !== 1) fail.push(`the step knob ended at ${tween.end.weather}, not 1`)
if (tween.end.active) fail.push('the transition is still in flight after its duration')
if (!tween.stepped?.includes('WEATHER')) fail.push('WEATHER was not reported as a knob that snaps')

// 4. going home
const home = await page.evaluate(() => {
  const a = window.corridor
  a.preset(a.presets.ground)
  return { weather: a.tune.get('WEATHER'), rate: a.tune.get('WEATHER_RATE') }
})
say('home again', home)
if (Math.abs(home.rate - after.ground) > 1e-9) fail.push(`going home left WEATHER_RATE at ${home.rate}, not the ground state\u2019s ${after.ground}`)

// 5. the tab exists and lists what the library holds
const tab = await page.evaluate(() => {
  const a = window.corridor
  a.tuneDialog.open?.()
  const btn = [...document.querySelectorAll('.tab')].find((b) => b.textContent?.trim() === 'presets')
  if (!btn) return { found: false }
  btn.click()
  const panel = [...document.querySelectorAll('.tab-panel')].find((p) => !p.hidden)
  return { found: true, rows: panel?.querySelectorAll('.preset-row').length ?? 0, text: (panel?.textContent ?? '').slice(0, 120) }
})
say('presets tab', tab)
if (!tab.found) fail.push('there is no presets tab in the tuning panel')
if (!tab.rows) fail.push('the presets tab lists no rows although the library holds one')

if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '))
try { await page.screenshot({ path: 'shots/presets.png', timeout: 120000 }) } catch { /* the verdict is the measurement */ }
await browser.close()
if (fail.length) { console.log('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1) }
console.log('\nPASS: library, ground state, tween and tab all behave in the page')
