// The world looks wet while it is wet: rain lowers the roughness of every hard surface, so the
// sky (and at night the headlights) reflect off it, and it dries slowly after the rain stops.
//   PORT=5185 node probes/corridor-wet.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 800, height: 500 } })
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/#${slug}?lite=1&fresh`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(3500)
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
/** the asphalt's own material, as the road is actually drawn */
const road = () => p.evaluate(() => {
  const site = window.corridor.site
  let best = null
  site.layers.road.traverse((o) => {
    const m = o.material
    if (!m || !m.isMeshStandardMaterial || !/asphalt|road/i.test(m.name || o.name || '')) return
    if (!best) best = { name: m.name || o.name, rough: +m.roughness.toFixed(3), env: +(m.envMapIntensity ?? 1).toFixed(2), colour: m.color.getHexString() }
  })
  if (!best) site.layers.road.traverse((o) => { const m = o.material; if (!best && m?.isMeshStandardMaterial) best = { name: m.name || o.name || '?', rough: +m.roughness.toFixed(3), env: +(m.envMapIntensity ?? 1).toFixed(2), colour: m.color.getHexString() } })
  return { road: best, wet: +site.weather.wetness.toFixed(3), weather: site.weather.current }
})
const dry = await road()
ok('it starts dry', dry.wet < 0.02 && !!dry.road, JSON.stringify(dry))
// rain, and give it time to soak
await p.evaluate(() => window.corridor.tune.set('WEATHER', 1))
// soaking is measured in SIMULATED seconds and the weather's tick caps its delta at a quarter of
// a second, so under swiftshader's two frames a second the world wets at about half speed. Wait
// for the state rather than for a stopwatch.
await p.waitForFunction(() => window.corridor.site.weather.wetness > 0.85, null, { timeout: 120000 }).catch(() => {})
const wet = await road()
ok('it rains, and the world soaks', wet.weather === 'rain' && wet.wet > 0.85, JSON.stringify(wet))
ok('the road turns reflective', wet.road.rough < dry.road.rough * 0.4, `roughness ${dry.road.rough} -> ${wet.road.rough}`)
ok('and darker', parseInt(wet.road.colour, 16) < parseInt(dry.road.colour, 16), `#${dry.road.colour} -> #${wet.road.colour}`)
ok('and it reflects the sky harder', wet.road.env > dry.road.env, `${dry.road.env} -> ${wet.road.env}`)
// stop the rain: it must NOT dry instantly
await p.evaluate(() => window.corridor.tune.set('WEATHER', 0))
await p.waitForTimeout(4000)
const after = await road()
ok('the rain stops', after.weather === 'clear')
ok('but the road is still wet a few seconds later', after.wet > wet.wet * 0.7, `wetness ${wet.wet} -> ${after.wet}`)
ok('and still reflective', after.road.rough < dry.road.rough * 0.7, `roughness ${after.road.rough} vs ${dry.road.rough} dry`)
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
