#!/usr/bin/env node
// Headless verification loop: boot the running dev server in Chromium, launch
// a run, play it for a few seconds, screenshot, and fail on any console error
// or unhandled rejection. This is the "did I break the game" check that a
// typecheck can't make.
//
//   just dev      # in one terminal
//   just smoke    # in another
//
// APEX_URL overrides the target; SMOKE_SECONDS the play time.

import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const url = process.env.APEX_URL ?? 'http://localhost:5180'
const seconds = Number(process.env.SMOKE_SECONDS ?? 6)
const outDir = 'shots'

const errors = []

const browser = await chromium.launch({
  // SwiftShader: the container has no GPU, and WebGL must still initialise.
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
})
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
  mkdirSync(outDir, { recursive: true })
  await page.screenshot({ path: `${outDir}/title.png` })

  // Launch, then hold thrust and weave, so the run exercises collision,
  // pickups and the chunk recycler rather than just the first frame.
  await page.keyboard.press('Enter')
  // Conduit: fire (Space) and shockwave (E) while weaving. Drivin: just drive — Space is the handbrake there.
  const isDrivin = /hard line/i.test(await page.title())
  const deadline = Date.now() + seconds * 1000
  await page.keyboard.down('KeyW')
  if (!isDrivin) await page.keyboard.down('Space')
  while (Date.now() < deadline) {
    await page.keyboard.down('KeyD')
    await page.waitForTimeout(isDrivin ? 150 : 400)
    await page.keyboard.up('KeyD')
    if (!isDrivin) await page.keyboard.press('KeyE')
    await page.keyboard.down('KeyA')
    await page.waitForTimeout(isDrivin ? 150 : 400)
    await page.keyboard.up('KeyA')
    await page.waitForTimeout(isDrivin ? 500 : 0)
  }
  if (!isDrivin) await page.keyboard.up('Space')
  await page.keyboard.up('KeyW')
  await page.screenshot({ path: `${outDir}/run.png` })

  // The run must have actually moved: a frozen frame is the failure this
  // catches that a screenshot alone would not.
  // Conduit shows course progress; drivin shows a speedometer. Either proves the sim moved.
  const moved = await page.evaluate(() => {
    const progress = parseFloat(document.querySelector('.hud [data-progress]')?.style.width ?? '0')
    const speed = parseFloat(document.querySelector('.hud [data-speed]')?.textContent ?? '0')
    return { progress, speed }
  })
  if (!(moved.progress > 1 || moved.speed > 5)) {
    errors.push(`nothing moved after ${seconds}s: ${JSON.stringify(moved)}`)
  }
  console.log(`smoke: ${JSON.stringify(moved)} after ${seconds}s → ${outDir}/run.png`)
} finally {
  await browser.close()
}

if (errors.length) {
  console.error('\nsmoke FAILED:')
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log('smoke OK')
