#!/usr/bin/env node
// The asset catalog in the editor, against a real assetsvc.
//
// Shoots the three states that matter — the list, one item's pipeline, and the Service tab — and
// reads the DOM as well as capturing pixels, because the interesting failures here are a thumbnail
// that 404s and a model dot that is green when the model is not actually reachable. A screenshot
// shows neither.
//
//   node probes/corridor-assets.mjs [port] [assetsvcUrl]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const port = process.argv[2] ?? '5212'
const svc = process.argv[3] ?? 'http://localhost:8770'
const out = 'shots/assets'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1360, height: 850 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
// A thumbnail or a glb that does not load is the whole point of this probe, so every failing
// request counts — except the editor's optional authored files, which are absent by design.
const EXPECTED_404 = /\/(adjustments|placements|structures|dead_ends)\.json/
page.on('response', (r) => {
  if (r.status() >= 400 && !EXPECTED_404.test(r.url())) errors.push(`${r.status()} ${r.url()}`)
})
await page.route('**/@vite/client', (r) => r.abort())

await page.goto(`http://localhost:${port}/editor.html?assetsvc=${encodeURIComponent(svc)}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
// the shell is built at module evaluation, long before the scene is ready
await page.waitForSelector('.topbar .btn[aria-label="generated assets"]', { timeout: 180000 })

const shot = async (name) => {
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 120000 })
  console.log(`  ${out}/${name}.png`)
}

console.log(`corridor assets — editor :${port}, service ${svc}`)
await page.click('.topbar .btn[aria-label="generated assets"]')
await page.waitForSelector('.asset-split, .asset-none', { timeout: 30000 })
await shot('01-catalog')

const rows = await page.locator('.asset-row').count()
if (rows) {
  await page.locator('.asset-row').first().click()
  await page.waitForSelector('.asset-steps')
  await shot('02-item')
}

await page.click('.tab:has-text("Service")')
await page.waitForSelector('.asset-model, .asset-none', { timeout: 30000 })
await shot('03-service')

// What is actually on the page, read rather than looked at.
const seen = await page.evaluate(() => {
  const thumbs = [...document.querySelectorAll('.asset-thumb img, .asset-view img')]
  return {
    items: document.querySelectorAll('.asset-row').length,
    chips: [...document.querySelectorAll('.asset-row .chip')].map((c) => c.textContent),
    thumbs: thumbs.length,
    // naturalWidth is 0 for an image that failed to load, which is the 404 a screenshot hides
    thumbsLoaded: thumbs.filter((i) => i.naturalWidth > 0).length,
    models: [...document.querySelectorAll('.asset-model')].map((m) => ({
      id: m.querySelector('.asset-model-id')?.textContent,
      dot: [...m.querySelector('.dot').classList].filter((c) => c !== 'dot')[0],
      detail: m.querySelector('.asset-model-detail')?.textContent,
    })),
  }
})
console.log('\n ', JSON.stringify(seen, null, 1).replace(/\n/g, '\n  '))

if (seen.thumbs !== seen.thumbsLoaded) console.log(`\n  ${seen.thumbs - seen.thumbsLoaded} THUMBNAILS FAILED TO LOAD`)
if (errors.length) {
  console.log(`\n  ${errors.length} ERRORS`)
  for (const e of errors.slice(0, 8)) console.log(`   ${e}`)
} else {
  console.log('\n  no page errors, no failed requests')
}
await browser.close()
process.exit(errors.length || seen.thumbs !== seen.thumbsLoaded ? 1 : 0)
