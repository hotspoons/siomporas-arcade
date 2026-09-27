// The readout names the road you are on — and it is the same road the physics has you on.
//   PORT=5185 node probes/corridor-roadname.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 700, height: 450 } })
p.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/?lite=1&fresh#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(3000)
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
// the site's own answer for a point ON the spine, against the manifest's own name for it
const check = await p.evaluate(() => {
  const site = window.corridor.site, m = site.manifest
  const c = m.spine.coords[Math.floor(m.spine.coords.length / 2)]
  const onSpine = site.roadAt(c[0], -c[1])
  const spineName = m.spine.segments?.[0]?.tags?.name ?? null
  // a branch with a name of its own
  const br = (m.branches ?? []).find((x) => x.name && x.coords?.length > 2)
  const bc = br?.coords[Math.floor(br.coords.length / 2)]
  const onBranch = bc ? site.roadAt(bc[0], -bc[1]) : null
  // and well away from any road
  const far = site.roadAt(c[0] + 600, -(c[1] + 600))
  return { onSpine, spineNames: (m.spine.segments ?? []).map((s) => s.tags?.name), branch: br?.name ?? null, onBranch, far }
})
ok('a point on the spine names a road', !!check.onSpine?.name, JSON.stringify(check.onSpine))
ok('and it is one of the spine\'s own segment names', check.spineNames.includes(check.onSpine?.name), `${check.onSpine?.name} in ${JSON.stringify([...new Set(check.spineNames)])}`)
ok('a point on a named branch names THAT branch', check.onBranch?.name === check.branch, `${check.branch} -> ${JSON.stringify(check.onBranch)}`)
ok('a point far from any road names nothing', check.far === null, JSON.stringify(check.far))
// and the HUD shows it while driving
await p.keyboard.press('Tab')
await p.waitForTimeout(1500)
const hud = await p.evaluate(() => document.querySelector('.hud-pos, #pos, [class*="pos"]')?.textContent ?? '')
ok('the drive readout carries the road name', /mph/.test(hud) && hud.split('·').length >= 3, JSON.stringify(hud))
const withName = await p.evaluate(() => {
  const car = window.corridor.drive.car
  return window.corridor.site.roadAt(car.pos.x, car.pos.z)?.name ?? null
})
ok('and it is the road the car is actually on', !!withName && hud.includes(withName), `readout ${JSON.stringify(hud)} vs roadAt ${withName}`)
// the knob turns it off
await p.evaluate(() => window.corridor.tune.set('HUD_ROAD_NAME', 0))
await p.waitForTimeout(1200)
const off = await p.evaluate(() => document.querySelector('.hud-pos, #pos, [class*="pos"]')?.textContent ?? '')
ok('HUD_ROAD_NAME 0 hides it', !withName || !off.includes(withName), JSON.stringify(off))
await p.evaluate(() => window.corridor.tune.set('HUD_ROAD_NAME', 1))
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
