// The editor's road cross-section panel: does the outline move when a slider does, and does apply
// push the numbers into tuning and rebuild?
//
//   node probes/corridor-roadwidth.mjs [site] [out.png]
import { chromium } from 'playwright'
const site = process.argv[2] ?? 'bowie-racetrack-rd'
const out = process.argv[3] ?? null
const PORT = process.env.CORRIDOR_PORT ?? '5202'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/editor.html#${site}:areas`, { waitUntil: 'domcontentloaded', timeout: 180000 })
await page.waitForFunction(() => document.querySelectorAll('#modes button').length > 4, null, { timeout: 240000 })
await page.waitForTimeout(3000)

const btn = page.locator('#modes button', { hasText: 'road' })
console.log('button present:', await btn.count())
await btn.click()
await page.waitForTimeout(800)

const widthOf = () => page.evaluate(() => {
  const g = window.__ed?.scene?.getObjectByName('roadwidth-preview')
  if (!g) return null
  const lines = g.children.filter((o) => o.isLine)
  if (lines.length < 2) return null
  const p = lines.map((l) => l.geometry.getAttribute('position'))
  // lateral separation of the two outlines at the first station = the proposed paved width
  const d = Math.hypot(p[0].getX(0) - p[1].getX(0), p[0].getZ(0) - p[1].getZ(0))
  return { lines: lines.length, points: p[0].count, visible: g.visible, width_m: +d.toFixed(2) }
})
const before = await widthOf()
// drag LANE_WIDTH to 5 m
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.roadwidth .field')]
  const row = rows.find((r) => r.textContent.includes('LANE_WIDTH'))
  const r = row.querySelector('input[type=range]')
  r.value = '5'
  r.dispatchEvent(new Event('input', { bubbles: true }))
})
await page.waitForTimeout(500)
const after = await widthOf()
const applyEnabled = await page.evaluate(() => !document.querySelector('.roadwidth-apply').disabled)
await page.click('.roadwidth-apply')
await page.waitForTimeout(2500)
const applied = await page.evaluate(() => {
  const keys = (window.__ed?.tune ?? []).flatMap((t) => t.sections.flatMap((s) => s.keys))
  return keys.find((k) => k.name === 'LANE_WIDTH')?.get() ?? null
})
console.log(JSON.stringify({ site, outline_before: before, outline_after: after, apply_enabled_after_drag: applyEnabled, LANE_WIDTH_after_apply: applied }, null, 1))
if (out) { await page.waitForTimeout(1500); await page.screenshot({ path: out, timeout: 180000, animations: 'disabled' }); console.log('shot', out) }
await browser.close()
