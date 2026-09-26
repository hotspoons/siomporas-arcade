// Time of day in the viewer: does the sun move, does the world go dark, and does the clock home?
//   PORT=5185 node probes/corridor-timeofday.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 700, height: 450 } })
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/?lite=1&fresh#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(2500)
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
const sky = () => p.evaluate(() => {
  const c = window.corridor
  const sun = c.scene.children.find((o) => o.isDirectionalLight)
  const amb = c.scene.children.find((o) => o.isHemisphereLight)
  const dome = c.scene.getObjectByName('sky')
  const u = dome?.material?.uniforms ?? {}
  const d = sun.position.clone().normalize()
  return {
    sunEl: +((Math.asin(d.y) * 180) / Math.PI).toFixed(2),
    sunAzFromNorth: +(((Math.atan2(d.x, -d.z) * 180) / Math.PI + 360) % 360).toFixed(1),
    sunI: +sun.intensity.toFixed(3),
    ambI: +amb.intensity.toFixed(3),
    night: +(u.uNight?.value ?? -1).toFixed(3),
    stars: +(u.uStars?.value ?? -1).toFixed(2),
    cirrus: +(u.uCirrus?.value ?? -1).toFixed(2),
    bg: c.scene.background.getHexString(),
    clockMs: c.time?.ms ?? null,
  }
})
const setTime = (date, time) => p.evaluate(({ date, time }) => window.corridor.time.setLocal(date, time), { date, time })
ok('the page exposes the world clock', await p.evaluate(() => !!window.corridor.time))
// --- noon in June: the sun is high and in the south -------------------------------------------
await setTime('2026-06-21', '13:00')
await p.waitForTimeout(900)
const noon = await sky()
ok('midday in June is a high sun', noon.sunEl > 60, `${noon.sunEl}°`)
ok('and it is in the south', Math.abs(noon.sunAzFromNorth - 180) < 35, `${noon.sunAzFromNorth}° from north`)
ok('it is daylight', noon.night < 0.05 && noon.sunI > 1, JSON.stringify(noon))
// --- the same day at dawn and dusk: the sun swaps sides ----------------------------------------
await setTime('2026-06-21', '06:30')
await p.waitForTimeout(900)
const dawn = await sky()
await setTime('2026-06-21', '19:30')
await p.waitForTimeout(900)
const dusk = await sky()
ok('the sun is in the east in the morning', dawn.sunAzFromNorth > 45 && dawn.sunAzFromNorth < 135, `${dawn.sunAzFromNorth}°`)
ok('and in the west in the evening', dusk.sunAzFromNorth > 225 && dusk.sunAzFromNorth < 315, `${dusk.sunAzFromNorth}°`)
// --- midnight: dark, with stars ----------------------------------------------------------------
await setTime('2026-06-21', '01:00')
await p.waitForTimeout(900)
const dark = await sky()
ok('the sun is below the horizon at 1 am', dark.sunEl < 0, `${dark.sunEl}°`)
ok('the world is night', dark.night > 0.95, `night=${dark.night}`)
ok('the sunlight all but goes out', dark.sunI < noon.sunI * 0.2, `${dark.sunI} vs ${noon.sunI}`)
ok('the ambient drops but does not vanish', dark.ambI < noon.ambI * 0.5 && dark.ambI > 0, `${dark.ambI} vs ${noon.ambI}`)
ok('the background is a night sky', parseInt(dark.bg, 16) < 0x333355, `#${dark.bg}`)
ok('stars are on', dark.stars > 0)
// --- December is a lower arc than June ---------------------------------------------------------
await setTime('2026-12-21', '13:00')
await p.waitForTimeout(900)
const dec = await sky()
ok('December noon is much lower than June noon', dec.sunEl < noon.sunEl - 35, `${dec.sunEl}° vs ${noon.sunEl}°`)
// --- the rate knob moves the sun by itself ------------------------------------------------------
await p.evaluate(() => window.corridor.tune.set('TIME_RATE', 3600))
const t0 = await sky()
await p.waitForTimeout(4000)
const t1 = await sky()
ok('at 3600x the sun moves on its own', Math.abs(t1.sunEl - t0.sunEl) > 1, `${t0.sunEl}° -> ${t1.sunEl}°`)
await p.evaluate(() => window.corridor.tune.set('TIME_RATE', 1))
// --- home comes back to the real now ------------------------------------------------------------
await p.evaluate(() => window.corridor.time.home())
await p.waitForTimeout(600)
const home = await sky()
ok('home puts the clock back on real time', Math.abs(home.clockMs - Date.now()) < 5000, `${((home.clockMs - Date.now()) / 1000).toFixed(0)} s from now`)
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
