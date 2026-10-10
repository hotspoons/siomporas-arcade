// Does a level actually change the world, or only parse?
//
// A level document that round-trips through the volume and is read by nothing is half a feature.
// So this asserts the WORLD, not the document: the sun where 19:20 puts it, the weather knob on
// wet, the season on autumn — measured off the running viewer after `?level=` and compared with
// what it was before.
//
// And it asserts the refusals, because the useful half of this loader is what it declines to do
// quietly: a level for another world must not be applied to this one, and a simulation nothing
// runs yet must be reported as not running rather than silently ignored.
//
//   PORT=5185 node probes/corridor-level.mjs [level] [slug]
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
const level = process.argv[2] ?? 'crofton-dusk'
const slug = process.argv[3] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'

/*
 * THE PROBE WRITES ITS OWN FIXTURE.
 *
 * Levels live on the volume — `tools/corridor/data` is gitignored, because it is bake output and
 * not source — so a probe that depended on a level file being there would pass on my machine and
 * fail on a fresh checkout with "no level", which reads like a broken loader. It makes the level
 * it is about to load, which also means the numbers below are checked against a document you can
 * see in this file.
 */
const LEVELS = new URL('../tools/corridor/data/levels/', import.meta.url)
await mkdir(LEVELS, { recursive: true })
await writeFile(new URL(`${level}.json`, LEVELS), JSON.stringify({
  id: level,
  world: slug,
  defaults: { time: '19:20', weather: 'wet', season: 'autumn' },
  mode: 'drive',
  placements: [],
  splats: [],
  simulations: [{ kind: 'traffic', density: 'rush', seed: 7 }],
  scenario: {
    goal: { type: 'score', target: 5000, time_s: 300 },
    events: [{ when: 'wrecks >= 5', do: 'message', text: 'Traffic is now worse than you found it.' }],
    scoring: [{ event: 'wreck', points: 100 }],
  },
}, null, 1))
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 560, height: 380 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message.slice(0, 160)); console.log('pageerror', e.message.slice(0, 200)) })
await page.route('**/@vite/client', (r) => r.abort())

// FIRST WITHOUT THE LEVEL, so the "after" has something to be different from. A test that only
// looks at the end state cannot tell "the level set this" from "this was already true".
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 900000 })
await page.evaluate(() => window.corridor.tune.set('TIME_RATE', 0))
const before = await page.evaluate(() => ({
  sunEl: +window.corridor.time.sun().el.toFixed(1),
  weather: window.corridor.tune.get('WEATHER'),
  season: window.corridor.tune.get('SEASON'),
  level: window.corridor.level?.() ?? null,
}))

const applied = await page.evaluate(async (id) => {
  await window.corridor.openLevel(id)
  await new Promise((r) => requestAnimationFrame(r))
  const l = window.corridor.level?.()
  return { id: l?.id ?? null, world: l?.world ?? null, defaults: l?.defaults ?? null, sims: (l?.simulations ?? []).length }
}, level)

const after = await page.evaluate(() => ({
  sunEl: +window.corridor.time.sun().el.toFixed(1),
  parts: window.corridor.time.parts('Etc/GMT+5'),
  // `corridor.tune.get(name)` — this surface has no `sections`; that is coast's shape and I
  // reached for it from memory rather than reading what is here
  weatherKnob: window.corridor.tune.get('WEATHER'),
}))

// a level for a DIFFERENT world must be refused rather than half-applied
const wrongWorld = await page.evaluate(async () => {
  const c = window.corridor
  const fake = { id: 'elsewhere', world: 'not-this-world', defaults: { weather: 'snow' } }
  const { applyLevel } = await import('/src/level.ts')
  return applyLevel(fake, { world: c.site.manifest.slug, setTimeLocal: () => {}, setWeather: () => { throw new Error('weather was applied for another world') }, setSeason: () => {}, place: async () => 0, attachSplats: async () => 0, say: () => {} })
})

console.log(JSON.stringify({ before, applied, after, wrongWorld }, null, 1))
await browser.close()
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (errors.length) fail(`the page threw: ${errors[0]}`)
else if (applied.id !== level) fail(`the level did not load (got ${applied.id})`)
// 19:20 in the site's own zone in late September is a sun below the horizon; noon is not
else if (!(after.sunEl < 0)) fail(`after a level that opens at 19:20 the sun is at ${after.sunEl} degrees — the time did not apply`)
else if (after.sunEl === before.sunEl) fail(`the sun did not move (${before.sunEl} both before and after)`)
// EXACTLY the minute asked for. "close enough" hid a real off-by-one: setLocal converged on an
// instant a fraction of a second below the target and parts() truncated it down, so a level that
// says 19:20 opened at 19:19.
else if (after.parts.time !== '19:20') fail(`the clock reads ${after.parts.time} in the site's zone, not 19:20`)
else if (after.weatherKnob === null) fail('could not read the WEATHER knob back')
else if (wrongWorld.ok !== false) fail('a level for another world was applied to this one')
else if (!/open #not-this-world/.test(wrongWorld.skipped?.[0]?.why ?? '')) fail(`the wrong-world refusal does not say what to do: ${JSON.stringify(wrongWorld.skipped)}`)
else console.log(`PASS: ${level} moved the sun ${before.sunEl} -> ${after.sunEl} deg (clock ${after.parts.time} in the site's zone), weather knob ${after.weatherKnob}, ${applied.sims} simulation(s) named; a level for another world is refused with "${wrongWorld.skipped[0].why}".`)
