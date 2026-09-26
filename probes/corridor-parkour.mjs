// Does Parkour boot and score: load ?game=parkour, run, jump with a spin held, roll out, and read
// the score and the trick line. A functional test of the runner on the real ground.
//   PORT=5185 node probes/corridor-parkour.mjs out.png
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const OUT = process.argv[2] ?? '/tmp/parkour.png'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.type(), m.text().slice(0, 300)) })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?game=parkour#crofton-triangle`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site && !!document.querySelector('#parkour'), null, { timeout: 300000 })
await page.evaluate(() => { const c = window.corridor; c.tune.set('GRASS_RADIUS', 30); c.tune.set('GRASS_SPRITE_RADIUS', 80); c.tune.set('GRASS_MOWN_PER_M2', 20); c.tune.set('GRASS_ROUGH_PER_M2', 10) })
// drive the game's tick directly with a steady dt so swiftshader's frame rate does not matter
const run = async (keys, seconds) => page.evaluate(({ keys, seconds }) => {
  for (const k of keys) dispatchEvent(new KeyboardEvent('keydown', { code: k }))
  const g = window.__parkour
  for (let i = 0; i < seconds * 60; i++) g.tick(1 / 60)
  for (const k of keys) dispatchEvent(new KeyboardEvent('keyup', { code: k }))
  return { pos: g.pos.toArray().map((v) => +v.toFixed(1)), grounded: g['grounded'], score: g.score, trick: document.querySelector('#parkour .parkour-trick')?.textContent }
}, { keys, seconds })
console.log('run 2 s', JSON.stringify(await run(['KeyW'], 2)))
// jump with a spin: Space down, hold D through the air, Space again near landing
const jump = await page.evaluate(() => {
  const g = window.__parkour
  dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }))
  g.tick(1 / 60)
  dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }))
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }))
  let maxY = -Infinity, air = 0
  for (let i = 0; i < 120; i++) {
    g.tick(1 / 60)
    maxY = Math.max(maxY, g.pos.y)
    if (!g['grounded']) air++
    // roll input just before landing: when falling and within 1 m of the ground
    if (g.vel.y < 0 && g.pos.y - (window.corridor.site.groundAt(g.pos.x, g.pos.z) ?? 0) < 1.0 && !window.__rolled) { window.__rolled = true; dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' })) }
  }
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD' }))
  return { maxRise: +(maxY - (window.corridor.site.groundAt(g.pos.x, g.pos.z) ?? 0)).toFixed(2), airFrames: air, score: g.score, trick: document.querySelector('#parkour .parkour-trick')?.textContent, goblins: g['goblins'].length }
})
console.log('jump', JSON.stringify(jump))
await page.keyboard.press('m')
await page.waitForTimeout(800)
await page.screenshot({ path: OUT, timeout: 300000 })
await browser.close()
