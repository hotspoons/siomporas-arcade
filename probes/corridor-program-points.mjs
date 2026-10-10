// Does the VIEWER's program host answer the new calls — points, world zones by id, spawning a
// library asset and a build at a point — against a real world?
//
// The unit tests (test/program-points.test.ts) step a GameRun against a fake host. This drives the
// real one: the game page, the world's own points.json and zones.json, the spawn catalog. The
// program is served by intercepting the viewer's `?js=1` request, so NOTHING is written to the
// programs volume — the probe is safe against a deployed editor.
//
//   PROBE_URL=http://127.0.0.1:5197 PROBE_BUILD=mister-pizza-suv node probes/corridor-program-points.mjs crofton-triangle
import { chromium } from 'playwright'

const base = process.env.PROBE_URL ?? 'http://localhost:5186'
const world = process.argv[2] ?? 'crofton-triangle'
const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

const zones = await fetch(`${base}/sites/${world}/zones.json`).then((r) => r.json())
const points = await fetch(`${base}/sites/${world}/points.json`).then((r) => r.json())
const zone = zones.zones[0]
const point = points.points[0]
say('zone / point', [zone.id, point.id])

// the program: everything it learns goes on window.__refsProbe, for this probe to read
const js = `
import { defineGame } from '@apex/program'
export default defineGame({
  setup(api) {
    const out = (window.__refsProbe = { entered: 0 })
    out.points = api.points().map((p) => p.id)
    out.point = api.point(${JSON.stringify(point.id)})
    out.none = api.point('no-such-point')
    const at = out.point
    out.asset = at ? api.models.spawn('barn-01', at) : null
    out.missing = api.models.spawn('no-such-asset', { x: 0, y: 0 })
    // a vehicle BUILD by its own id wears its model (the spawn catalog, catalogmerge.ts)
    out.build = at && ${JSON.stringify(process.env.PROBE_BUILD ?? '')} ? api.models.spawn(${JSON.stringify(process.env.PROBE_BUILD ?? '')}, { ...at, x: at.x + 8 }) : null
    out.where = out.asset ? api.models.where(out.asset) : null
    api.on('enters', ${JSON.stringify(zone.id)}, () => { out.entered++ })
    api.each(() => { out.inZone = api.in(${JSON.stringify(zone.id)}) })
  },
})
`

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
// a LEVEL naming the program, served the same way: the viewer runs a level's program on open,
// which is the path a real level takes (startProgram is only on the dev bridge)
const level = { id: 'zz-refs-probe', world, program: 'zz-refs-probe.ts' }
await page.route('**/api/levels/zz-refs-probe', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ level, ok: true, errors: [], warnings: [] }) }))
await page.route('**/api/programs/zz-refs-probe.ts?js=1', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'zz-refs-probe.ts', js, errors: [] }) }))
await page.goto(`${base}/#${world}?level=zz-refs-probe`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 180000 })
say('booted', true)
const started = await page.waitForFunction(() => !!window.__refsProbe, null, { timeout: 60000 }).then(() => true, () => false)
say('program started', started)
if (!started) fail.push('the level\'s program did not start')
await page.waitForTimeout(1500)
let p = await page.evaluate(() => window.__refsProbe)
say('points', p?.points)
say('point', p?.point)
say('spawn (kit / build / missing)', [p?.asset, p?.build, p?.missing])
if (process.env.PROBE_BUILD && !p?.build) fail.push(`spawning the build ${process.env.PROBE_BUILD} answered null`)
say('where it stands', p?.where)
if (!p?.point || p.point.id !== point.id) fail.push('api.point did not find the world\'s point')
if (p?.point && (Math.abs(p.point.x - point.at[0]) > 1e-6 || Math.abs(p.point.y - point.at[1]) > 1e-6)) fail.push('api.point is not in the document\'s site metres')
if (p?.point && typeof p.point.z !== 'number') fail.push('api.point has no height in the viewer')
if (p?.none !== null) fail.push('an unknown point was not null')
if (!p?.asset) fail.push('spawning a kit asset at the point answered null')
if (p?.missing !== null) fail.push('spawning an unknown asset was not null')
if (p?.where && (Math.abs(p.where.x - point.at[0]) > 0.01 || Math.abs(p.where.y - point.at[1]) > 0.01)) fail.push('the spawned model is not at the point')

// into the zone, by the developer teleport: `enters` must fire on a zone the program never declared
const [cx, cy] = zone.polygon.slice(0, 4).reduce(([a, b], [x, y]) => [a + x / 4, b + y / 4], [0, 0])
await page.evaluate(([x, y]) => window.corridor.chrome.teleport(x, y), [cx, cy])
await page.waitForTimeout(2500)
p = await page.evaluate(() => window.__refsProbe)
const car = await page.evaluate(() => window.corridor.game?.error ?? null)
say('after teleport', { entered: p?.entered, inZone: p?.inZone, programError: car })
if (!(p?.entered >= 1)) fail.push(`entering ${zone.id} did not fire on('enters')`)
if (car) fail.push(`the program stopped: ${car}`)

say('page errors', errs)
await browser.close()
if (fail.length) {
  console.log(`\nFAIL\n  ${fail.join('\n  ')}`)
  process.exit(1)
}
console.log('\nPASS')
