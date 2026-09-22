#!/usr/bin/env node
// Shoot the new interface: the bar over the scene, the drawer, every settings tab, and the tuning
// dialog. Also fails loudly on a page error, because a UI that throws on open still screenshots
// fine — the old panel's markup was replaced wholesale here and a missing element is silent.
//
//   node probes/corridor-ui.mjs [slug] [port]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const slug = process.argv[2] ?? 'arrowhead-farms'
const port = process.argv[3] ?? '5211'
const out = 'shots/ui'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
// deviceScaleFactor 1: swiftshader composites the live scene for every capture, and at 2x on a
// 1440px viewport that alone blows the screenshot timeout.
const page = await browser.newPage({ viewport: { width: 1360, height: 850 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
// A console error is only news if it is not one of the editor's OPTIONAL files. adjustments.json,
// placements.json and structures.json do not exist until somebody authors that site, and the
// editor is meant to treat absent as "none yet" — counting those 404s as failures made a clean
// run look broken. Anything else still counts.
const EXPECTED_404 = /\/(adjustments|placements|structures|dead_ends)\.json/
page.on('response', (r) => {
  if (r.status() >= 400 && !EXPECTED_404.test(r.url())) errors.push(`${r.status()} ${r.url()}`)
})
await page.route('**/@vite/client', (r) => r.abort())

await page.goto(`http://localhost:${port}/#${slug}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
// __apex is the dev-bridge context and the one that carries `renderer`; window.corridor exists
// too and probing it 'works' while silently lacking renderer and perf. Prefer the bridge.
await page.waitForFunction(() => !!(window.__apex ?? window.corridor)?.site, null, { timeout: 300000 })
await page.waitForTimeout(2500)

const shot = async (name, prep) => {
  if (prep) await prep()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 120000 })
  console.log(`  ${out}/${name}.png`)
}

const only = process.env.ONLY ?? ''
console.log(`corridor UI — ${slug}${only ? ` (${only} only)` : ''}`)
if (only !== 'editor') {
await shot('01-scene')
await shot('02-drawer', () => page.click('.topbar .btn[aria-label="menu"]'))
await page.keyboard.press('Escape')

// every settings tab, so a broken one cannot hide behind a tab that works
await page.click('.topbar .btn[aria-label="settings"]')
for (const tab of ['Layers', 'Display', 'Site', 'Controls']) {
  await shot(`03-settings-${tab.toLowerCase()}`, () => page.click(`.tab:has-text("${tab}")`))
}
await page.keyboard.press('Escape')

await shot('04-tuning', () => page.keyboard.press('F6'))
await page.keyboard.press('Escape')

// light theme, to prove the tokens actually carry a second theme rather than claiming to
await shot('05-light', async () => {
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
  await page.click('.topbar .btn[aria-label="settings"]')
})
await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
await page.keyboard.press('Escape')

// phone width: the bar has to survive losing 800 px
await page.setViewportSize({ width: 390, height: 844 })
await shot('06-phone')
await page.setViewportSize({ width: 1360, height: 850 })
}

// ---- the editor, which shares every one of the parts above
await page.goto(`http://localhost:${port}/editor.html#${slug}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
await page.waitForFunction(() => !!window.__ed?.site, null, { timeout: 300000 })
await page.waitForTimeout(2000)
await shot('07-editor')
await shot('08-editor-place', () => page.click('.seg:has-text("Place")'))
await shot('09-editor-settings', () => page.click('.topbar .btn[aria-label="settings"]'))
await page.keyboard.press('Escape')

// What the interface is made of, counted — a cheap regression net for the next change.
const counts = await page.evaluate(() => ({
  topbarButtons: document.querySelectorAll('.topbar .btn').length,
  drawerItems: document.querySelectorAll('.drawer-item').length,
  layerToggles: document.querySelectorAll('.field.layer').length,
  icons: document.querySelectorAll('svg.icon').length,
  font: getComputedStyle(document.body).fontFamily.split(',')[0].replace(/"/g, ''),
}))
console.log('\n ', JSON.stringify(counts))

if (errors.length) {
  console.log(`\n  ${errors.length} PAGE ERRORS`)
  for (const e of errors.slice(0, 10)) console.log(`   ${e}`)
} else {
  console.log('\n  no page errors')
}
await browser.close()
process.exit(errors.length ? 1 : 0)
