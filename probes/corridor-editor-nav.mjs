// The place editor's map navigation, measured (src/editor/view/nav.ts, maproads.ts).
//
// Rich, 2026-10-10: "adopt the full navigation experience from trailworks, including point-based
// zooms and pivots … major roads listed at high level overview zooms … secondary roads when zoomed
// in at z14 level. Need road labels too."
//
// Every promise is a pixel or a count, through REAL mouse input: the ground point under the cursor
// does not move under a wheel zoom, a grabbed point follows the cursor, a middle-drag pivot holds its
// pixel; the street tier appears at z14 and the names with it; W slides north; buildings appear
// close in. Then what a frame costs while panning and zooming (CPU of the camera + map, the render
// call, draw calls). Screenshots at overview, mid, orbit, z14 and close go to $OUT.
//
//   PORT=5185 OUT=/tmp node probes/corridor-editor-nav.mjs [slug]     (dc-metro-take-2 is the scale case)
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const SLUG = process.argv[2] ?? 'dc-metro-take-2'
const SHOTS = process.env.OUT ?? '/tmp'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
const fail = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const say = (k, v) => console.log(`${k.padEnd(30)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
const t0 = Date.now()
await page.goto(`http://127.0.0.1:${PORT}/editor.html#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
const tSite = Date.now() - t0
await page.waitForFunction(() => window.corridor.roads.stats.built > 0, null, { timeout: 120000 })
const tLegible = Date.now() - t0
const legible = await page.evaluate(() => ({ firstMajorPageMs: window.corridor.roads.stats.firstMajorPageMs, siteReadyApprox: Math.round(performance.now()) }))
say('site ready / first roads ms (wall)', [tSite, tLegible])
const bootSegs = (await page.evaluate(() => window.corridor.roads.stats.segments))
say('first legible frame (page clock ms)', legible.firstMajorPageMs)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${SHOTS}/${SLUG}-1-overview.png` })

const box = await page.$eval('#gl', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const settle = async () => {
  await page.waitForFunction(() => window.corridor.nav.state === 'idle' && !window.corridor.nav.moving, null, { timeout: 120000, polling: 250 }).catch(() => fail.push('the camera never settled'))
}
// world → screen
const proj = (p) => page.evaluate((p) => {
  const c = window.corridor
  const v = c.camera.position.clone().set(p.x, p.y, p.z).project(c.camera)
  const r = document.querySelector('#gl').getBoundingClientRect()
  return { x: (v.x + 1) / 2 * r.width + r.left, y: (1 - v.y) / 2 * r.height + r.top }
}, p)
const pick = (x, y) => page.evaluate(([x, y]) => { const p = window.corridor.nav.pickAt(x, y); return p && { x: p.x, y: p.y, z: p.z } }, [x, y])
const state = () => page.evaluate(() => ({ mpp: +window.corridor.nav.metresPerPixel.toFixed(2), d: Math.round(window.corridor.nav.distance), pitch: +window.corridor.nav.pitchDeg.toFixed(1), heading: +window.corridor.nav.headingDeg.toFixed(1), roads: window.corridor.roads.stats }))

// ---- 1 · wheel zoom toward the cursor keeps the ground under it
const zx = box.x + box.w * 0.42, zy = box.y + box.h * 0.36
const g0 = await pick(zx, zy)
await page.mouse.move(zx, zy)
for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -240); await page.waitForTimeout(60) }
await settle()
const s1 = await proj(g0)
const e1 = Math.hypot(s1.x - zx, s1.y - zy)
say('zoom-to-cursor drift px', +e1.toFixed(2))
if (!(e1 < 3)) fail.push(`zoom-to-cursor moved the ground point under the cursor by ${e1.toFixed(1)} px`)
say('after wheel', await state())

// mid: about 20 m a pixel — the tier-1 roads are not in yet
for (let k = 0; k < 20; k++) {
  const st = await state()
  if (st.mpp <= 22) break
  await page.mouse.wheel(0, -160)
  await page.waitForTimeout(120)
  await settle()
}
await page.waitForTimeout(1500)
const mid = await state()
say('mid', mid)
await page.screenshot({ path: `${SHOTS}/${SLUG}-2-mid.png` })

// ---- 2 · grab-pan keeps the grabbed point under the cursor
const px0 = box.x + box.w * 0.5, py0 = box.y + box.h * 0.5
const gp = await pick(px0, py0)
await page.mouse.move(px0, py0)
await page.mouse.down({ button: 'left' })
for (let i = 1; i <= 10; i++) { await page.mouse.move(px0 - 22 * i, py0 + 9 * i); await page.waitForTimeout(16) }
const sp = await proj(gp)
const ep = Math.hypot(sp.x - (px0 - 220), sp.y - (py0 + 90))
say('grab-pan drift px', +ep.toFixed(2))
if (!(ep < 2)) fail.push(`the grabbed ground point left the cursor by ${ep.toFixed(1)} px`)
await page.waitForTimeout(300) // stop the hand before releasing: no flick
await page.mouse.up({ button: 'left' })
await settle()

// ---- 3 · middle-drag orbits about the pressed point, which holds its pixel
const ox = box.x + box.w * 0.6, oy = box.y + box.h * 0.55
const go = await pick(ox, oy)
await page.mouse.move(ox, oy)
await page.mouse.down({ button: 'middle' })
for (let i = 1; i <= 12; i++) { await page.mouse.move(ox + 14 * i, oy - 9 * i); await page.waitForTimeout(16) }
const so = await proj(go)
const eo = Math.hypot(so.x - ox, so.y - oy)
await page.mouse.up({ button: 'middle' })
const orb = await state()
say('orbit pivot drift px', +eo.toFixed(2))
say('after orbit', { pitch: orb.pitch, heading: orb.heading })
if (!(eo < 2)) fail.push(`the orbit pivot moved by ${eo.toFixed(1)} px`)
if (!(orb.pitch > 5)) fail.push('middle-drag did not tilt the view')
await settle()
await page.screenshot({ path: `${SHOTS}/${SLUG}-3-orbit.png` })

// ---- back to north-up and zoom to the z14 tier
await page.keyboard.press('Home')
await page.waitForTimeout(1500)
await settle()
const cx = box.x + box.w * 0.5, cy = box.y + box.h * 0.5
await page.mouse.move(cx, cy)
for (let k = 0; k < 30; k++) {
  const st = await state()
  if (st.mpp <= 8) break
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(120)
  await settle()
}
await settle()
await page.waitForTimeout(3000)
const z14 = await state()
say('z14', z14)
// the overview draws only the major tier; at z14 the streets must have been added to it
if (!(z14.roads.segments > bootSegs)) fail.push('zooming to z14 drew no more roads than the overview — the minor tier did not appear')
say('segments overview → z14', [bootSegs, z14.roads.segments])
if (!(z14.roads.labels > 0)) fail.push('no road names at z14')
await page.screenshot({ path: `${SHOTS}/${SLUG}-4-z14.png` })

// ---- 4 · frame cost while panning and zooming
await page.evaluate(() => {
  window.__ri = []
  let last = performance.now()
  const tick = () => { const n = performance.now(); window.__ri.push(n - last); last = n; if (window.__ri.length < 100000) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  window.__perf0 = window.__mapPerf().n
})
const T0 = Date.now()
let dir = 1
while (Date.now() - T0 < 12000) {
  const x = box.x + box.w * (0.3 + Math.random() * 0.4), y = box.y + box.h * (0.3 + Math.random() * 0.4)
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) { await page.mouse.move(x + 25 * i * dir, y + 10 * i); await page.waitForTimeout(16) }
  await page.mouse.up()
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, dir * 200); await page.waitForTimeout(40) }
  dir = -dir
}
await settle()
const perf = await page.evaluate(() => {
  const all = window.__mapPerf()
  const k = Math.min(all.n - window.__perf0, all.nav.length)
  const lastK = (a) => a.slice(Math.max(0, a.length - k))
  const pc = (a, q) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(2) }
  const ri = window.__ri.slice(2)
  return {
    frames: k,
    rafInterval: { p50: pc(ri, 0.5), p99: pc(ri, 0.99) },
    navAndMapCpu: { p50: pc(lastK(all.nav), 0.5), p99: pc(lastK(all.nav), 0.99) },
    renderCall: { p50: pc(lastK(all.render), 0.5), p99: pc(lastK(all.render), 0.99) },
    drawCalls: { p50: pc(lastK(all.calls), 0.5), max: Math.max(...lastK(all.calls)) },
    roads: window.corridor.roads.stats,
  }
})
say('perf while moving', perf)

// ---- 5 · close in, buildings on
await page.evaluate(() => {
  const c = window.corridor
  c.footprints.on = true
})
for (let k = 0; k < 40; k++) {
  const st = await state()
  if (st.mpp <= 0.9) break
  await page.mouse.move(cx, cy)
  await page.mouse.wheel(0, -200)
  await page.waitForTimeout(120)
  await settle()
}
await settle()
await page.waitForFunction(() => window.corridor.footprints.stats.footprints > 0, null, { timeout: 60000 }).catch(() => fail.push('buildings never appeared'))
await page.waitForTimeout(2500)
const close = await state()
const fb = await page.evaluate(() => ({ ...window.corridor.footprints.stats, calls: window.__mapPerf().calls.slice(-1)[0] }))
say('close', close)
say('buildings', fb)
await page.screenshot({ path: `${SHOTS}/${SLUG}-5-close-buildings.png` })

// ---- 6 · keys: W slides the view north (heading 0)
const tBefore = await page.evaluate(() => window.corridor.orbitTarget.toArray())
await page.mouse.move(box.x + 5, box.y + 5)
await page.keyboard.down('KeyW')
await page.waitForTimeout(700)
await page.keyboard.up('KeyW')
const tAfter = await page.evaluate(() => window.corridor.orbitTarget.toArray())
say('W moved target (dx, dz)', [+(tAfter[0] - tBefore[0]).toFixed(1), +(tAfter[2] - tBefore[2]).toFixed(1)])
if (!(tAfter[2] < tBefore[2] - 1)) fail.push('W did not move the view north')

say('page errors', errs)
if (errs.length) fail.push('page errors')
console.log(fail.length ? `\nFAIL\n - ${fail.join('\n - ')}` : '\nPASS')
await browser.close()
process.exit(fail.length ? 1 : 0)
