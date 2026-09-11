#!/usr/bin/env node
// Does the fighter actually run in a browser, and does pressing a button reach the simulation?
//
//   just dev fighter                   # in one terminal
//   node scripts/fighter-smoke.mjs     # in another
//
// The sim is covered by unit tests and needs no browser at all. This checks the half those cannot:
// that the page boots, the loop runs, the canvas has something on it, and a keypress arrives in the
// fight. It also drops screenshots into shots/ so the placeholder art can be looked at without
// anyone having to play it.
//
// FIGHTER_URL overrides the target.

import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const url = process.env.FIGHTER_URL ?? 'http://localhost:5184'
const outDir = 'shots'
mkdirSync(outDir, { recursive: true })

const failures = []
function check(ok, what) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('console', (m) => {
  if (m.type() === 'error') failures.push(`console: ${m.text()}`)
})
page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`))

await page.goto(url, { waitUntil: 'load' })
await page.waitForFunction(() => 'fighter' in window, null, { timeout: 15000 })
await page.waitForFunction(() => window.fighter.match.phase === 'fight', null, { timeout: 10000 })

const started = await page.evaluate(() => window.fighter.match.frame)
check(started > 60, `loop is running (frame ${started})`)

// Not a black rectangle.
const colours = await page.evaluate(() => {
  const cv = document.querySelector('canvas')
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
  const seen = new Set()
  for (let i = 0; i < d.length; i += 4 * 997) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`)
  return seen.size
})
check(colours > 8, `canvas has ${colours} distinct colours in it`)
await page.screenshot({ path: `${outDir}/fighter-idle.png` })

// Walking has to move the fighter.
const startX = await page.evaluate(() => window.fighter.match.fighters[0].x)
await page.keyboard.down('KeyD')
await page.waitForTimeout(500)
await page.keyboard.up('KeyD')
const walkedX = await page.evaluate(() => window.fighter.match.fighters[0].x)
check(walkedX > startX + 5, `walking moved the fighter ${(walkedX - startX).toFixed(0)}px`)

// A button has to start a move. Sampled, because a jab is over in eleven frames.
const swung = await page.evaluate(async () => {
  const g = window.fighter
  const seen = new Set()
  const t = setInterval(() => g.match.fighters[0].action && seen.add(g.match.fighters[0].action.id), 8)
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH' }))
  await new Promise((r) => setTimeout(r, 120))
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyH' }))
  await new Promise((r) => setTimeout(r, 400))
  clearInterval(t)
  return [...seen]
})
check(swung.length > 0, `heavy punch reached the sim (${swung.join(', ') || 'nothing'})`)

// The hitbox overlay, which is most of what this build is for.
await page.keyboard.press('F1')
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH' })))
await page.waitForTimeout(70)
await page.screenshot({ path: `${outDir}/fighter-debug.png` })
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyH' })))
const debugOn = await page.evaluate(() => window.fighter.options.debug)
check(debugOn, 'F1 turned the hitbox overlay on')

// Let the CPU actually fight for a few seconds and confirm someone took damage.
await page.keyboard.press('F1')
await page.evaluate(() => window.fighter.setOpponent('hard'))
const full = await page.evaluate(() => window.fighter.match.fighters.map((f) => f.character.health))
for (let i = 0; i < 6; i++) {
  for (const code of ['KeyD', 'KeyH', 'KeyB']) {
    await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c })), code)
    await page.waitForTimeout(90)
    await page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c })), code)
  }
}
await page.waitForTimeout(800)

// Catch the game mid-hitstop, which is the only moment the impact mark and the flash are up.
await page.evaluate(async () => {
  const g = window.fighter
  g.setOpponent('dummy')
  g.reset()
  return new Promise((r) => setTimeout(r, 1800)) // let the round intro finish
})
await page.waitForFunction(() => window.fighter.match.phase === 'fight', null, { timeout: 8000 })
await page.evaluate(async () => {
  const g = window.fighter
  g.match.fighters[0].x = -46
  g.match.fighters[1].x = 46
  await new Promise((r) => setTimeout(r, 60))
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH' }))
  await new Promise((r) => setTimeout(r, 40))
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyH' }))
  await new Promise((r) => setTimeout(r, 100))
})
const froze = await page.evaluate(() => window.fighter.match.impacts.length)
check(froze > 0, `impact mark is up (${froze})`)
await page.screenshot({ path: `${outDir}/fighter-impact.png` })

const health = await page.evaluate(() => window.fighter.match.fighters.map((f) => f.health))
check(health.some((h, i) => h < full[i]), `someone got hit — health ${health.join(' / ')} of ${full.join(' / ')}`)
await page.screenshot({ path: `${outDir}/fighter-fight.png` })

console.log(`\n  ${outDir}/fighter-{idle,debug,fight,impact}.png`)
await browser.close()

if (failures.length) {
  console.error(`\nfighter-smoke: ${failures.length} problem(s)`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
console.log('\nfighter-smoke: ok')
