// Reproduce the default load of a site and isolate a visual by hiding one layer at a time.
import { chromium } from 'playwright'
const [,, slug, outDir] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(m.type(), m.text().slice(0, 200)) })
await page.goto(`http://127.0.0.1:5185/?season=summer#${slug}`, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.waitForTimeout(2000)
await page.screenshot({ path: `${outDir}/iso-0-default.png`, timeout: 120000 })
const layers = await page.evaluate(() => {
  const s = window.corridor.site
  const names = {}
  s.group.children.forEach((c) => { names[c.name || c.type] = c.children?.length ?? 0 })
  const road = s.layers.road.children.map((c) => `${c.name || c.type}:${c.children?.length ?? ''}`)
  return { top: names, road, treesChildren: s.layers.trees?.children.map((c) => c.name) }
})
console.log(JSON.stringify(layers))
const steps = [['strip', () => window.corridor.site.layers.road.getObjectByName('strip')], ['road-surface', () => window.corridor.site.layers.road.children.filter((c) => c.name !== 'strip')], ['trees', () => window.corridor.site.layers.trees], ['terrain', () => window.corridor.site.terrain]]
for (const [name] of steps) {
  await page.evaluate((n) => {
    const s = window.corridor.site
    const target = n === 'strip' ? [s.layers.road.getObjectByName('strip')] : n === 'road-surface' ? s.layers.road.children.filter((c) => c.name !== 'strip') : n === 'trees' ? [s.layers.trees] : [s.terrain]
    window.__hidden = target.filter(Boolean)
    for (const o of window.__hidden) o.visible = false
  }, name)
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${outDir}/iso-hide-${name}.png`, timeout: 120000 })
  await page.evaluate(() => { for (const o of window.__hidden) o.visible = true })
}
await browser.close()
