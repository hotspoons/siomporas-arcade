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
  const deadline = Date.now() + seconds * 1000
  await page.keyboard.down('KeyW')
  await page.keyboard.down('Space')
  while (Date.now() < deadline) {
    await page.keyboard.down('KeyD')
    await page.waitForTimeout(400)
    await page.keyboard.up('KeyD')
    await page.keyboard.press('KeyE')
    await page.keyboard.down('KeyA')
    await page.waitForTimeout(400)
    await page.keyboard.up('KeyA')
  }
  await page.keyboard.up('Space')
  await page.keyboard.up('KeyW')
  await page.screenshot({ path: `${outDir}/run.png` })

  // The run must have actually moved: a frozen frame is the failure this
  // catches that a screenshot alone would not.
  const progress = await page.evaluate(() => parseFloat(document.querySelector('.hud [data-progress]')?.style.width ?? '0'))
  if (!Number.isFinite(progress) || progress < 1) {
    errors.push(`craft barely moved: ${progress}% of the course after ${seconds}s`)
  }
  console.log(`smoke: ${progress.toFixed(1)}% of the course in ${seconds}s → ${outDir}/run.png`)
} finally {
  await browser.close()
}

if (errors.length) {
  console.error('\nsmoke FAILED:')
  for (const e of errors) console.error('  ' + e)
  process.exit(1)
}
console.log('smoke OK')
