// Headless probe: load the dev server in SwiftShader Chromium, optionally run
// a JS snippet against window.__apex (needs `just bridge-dev`), play for a few
// seconds holding keys, print sim/render stats and screenshot. Slow (software
// GL), so it's for "does it render / did it break", not for perf numbers.
//
//   just probe shots/run.png 5 KeyW KeyD
//   PROBE_JS='window.__apex.world.vehicle.s = 4700' just probe shots/split.png 2 KeyW
//   PROBE_URL='http://localhost:5180/?style=retro' just probe shots/retro.png 3
import { chromium } from 'playwright'
const [out = 'shots/probe.png', play = '0', ...keys] = process.argv.slice(2)
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'] })
const page = await browser.newPage({ viewport: { width: 960, height: 540 } })
const logs = []
page.on('console', (m) => { if (m.type() !== 'debug' && !/GL Driver|vite\]/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`))
await page.goto(process.env.PROBE_URL ?? 'http://localhost:5180', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)
if (process.env.PROBE_JS) console.log('js:', JSON.stringify(await page.evaluate(process.env.PROBE_JS)))
if (Number(play) > 0) {
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  for (const k of keys) await page.keyboard.down(k)
  await page.waitForTimeout(Number(play) * 1000)
  for (const k of keys) await page.keyboard.up(k)
}
if (process.env.PROBE_JS_END) console.log('end:', JSON.stringify(await page.evaluate(process.env.PROBE_JS_END)))
const state = await page.evaluate(() => {
  const a = window.__apex
  if (!a) return 'no apex'
  const s = a.snap
  return { s: s.vehicle.s, theta: s.vehicle.theta, speed: s.vehicle.speed, phase: s.phase, shield: s.hud.shield, traffic: s.trafficCount, fps: a.loop.stats.fps, draws: a.view.stats.drawCalls, tris: a.view.stats.triangles, chunks: a.view.stats.chunks, state: a.game.state }
})
console.log(JSON.stringify(state))
console.log(logs.join('\n').slice(0, 4000))
await page.screenshot({ path: out })
await browser.close()
