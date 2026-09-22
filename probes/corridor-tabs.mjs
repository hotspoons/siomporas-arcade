#!/usr/bin/env node
// Does the tab strip's highlight actually follow the panel it shows?
//
// A screenshot of the Site tab came back with the SITE panel's content under the DISPLAY tab's
// underline, which is either a real bug in Tabs.show or an artefact of a 60-second swiftshader
// capture. This reads the DOM instead of looking at pixels, so it answers in seconds and cannot
// be fooled by a slow compositor.
//
//   node probes/corridor-tabs.mjs [port]
import { chromium } from 'playwright'

const port = process.argv[2] ?? '5211'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 180000 })
// the shell is built synchronously at module evaluation, so it exists long before the scene does
await page.waitForSelector('.topbar .btn[aria-label="settings"]', { timeout: 180000 })
await page.click('.topbar .btn[aria-label="settings"]')
await page.waitForSelector('.tab')

let bad = 0
for (const want of ['Layers', 'Display', 'Site', 'Controls']) {
  await page.click(`.tab:has-text("${want}")`)
  await page.waitForTimeout(150)
  const seen = await page.evaluate(() => {
    const strip = document.querySelector('.tab-strip')
    const on = [...strip.querySelectorAll('.tab')].filter((b) => b.classList.contains('on')).map((b) => b.textContent.trim())
    const selected = [...strip.querySelectorAll('.tab')].filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.textContent.trim())
    const shown = [...document.querySelectorAll('.tab-panel')].filter((p) => !p.hidden)
    // name the visible panel by its first group heading, which is unique per tab
    const heading = shown[0]?.querySelector('.group-head span, .empty')?.textContent?.trim() ?? '(empty)'
    return { on, selected, panels: shown.length, heading }
  })
  const ok = seen.on.length === 1 && seen.on[0] === want && seen.selected[0] === want && seen.panels === 1
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'BAD '} click ${want.padEnd(9)} highlight=${JSON.stringify(seen.on)} aria=${JSON.stringify(seen.selected)} panelsVisible=${seen.panels} firstHeading=${JSON.stringify(seen.heading)}`)
}

console.log(bad ? `\n  ${bad} tab(s) wrong` : '\n  viewer: highlight follows the panel on every tab')

// ---- the editor's mode rail, which has the same job and a separate implementation
await page.goto(`http://localhost:${port}/editor.html`, { waitUntil: 'domcontentloaded', timeout: 180000 })
await page.waitForSelector('.mode-host .seg', { timeout: 180000 })
for (const want of ['areas', 'place', 'grow', 'structures']) {
  await page.click(`.mode-host .seg[data-value="${want}"]`)
  await page.waitForTimeout(150)
  const seen = await page.evaluate(() => {
    const on = [...document.querySelectorAll('.mode-host .seg')].filter((b) => b.classList.contains('on')).map((b) => b.dataset.value)
    const heading = document.querySelector('.inspector-body h2, .inspector-body .empty')?.textContent?.trim() ?? '(empty)'
    return { on, heading }
  })
  const ok = seen.on.length === 1 && seen.on[0] === want
  if (!ok) bad++
  console.log(`  ${ok ? 'ok  ' : 'BAD '} mode ${want.padEnd(11)} highlight=${JSON.stringify(seen.on)} inspector=${JSON.stringify(seen.heading.slice(0, 48))}`)
}
console.log(bad ? `\n  ${bad} wrong` : '  editor: highlight follows the mode on every one')
await browser.close()
process.exit(bad ? 1 : 0)
