import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
await page.goto('http://127.0.0.1:5185/?lite#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
const r = await page.evaluate(() => {
  const s = window.corridor.site
  const s0 = s.manifest.spine.photo_s
  const rows = []
  let maxStep = 0, maxDiff = 0
  for (let d = 0; d <= 40; d += 0.5) {
    const p = s.spineAt(s0 + d)
    const side = p.dir.clone().cross({ x: 0, y: 1, z: 0, ...new (Object.getPrototypeOf(p.dir).constructor)(0, 1, 0) })
    const x = p.pos.x + side.x * 1.83, z = p.pos.z + side.z * 1.83
    const g = s.groundAt(x, z)
    const road = p.pos.y // the spline height is the canonical road surface
    if (rows.length) maxStep = Math.max(maxStep, Math.abs(g - rows[rows.length - 1].g))
    maxDiff = Math.max(maxDiff, Math.abs(g - road))
    rows.push({ d, g: +g.toFixed(3), road: +road.toFixed(3) })
  }
  return { maxStepPerHalfMetre: +maxStep.toFixed(3), maxGroundVsRoad: +maxDiff.toFixed(3), sample: rows.slice(0, 16).map((r) => `${r.d}:${r.g}/${r.road}`).join(' ') }
})
console.log(JSON.stringify(r))
await browser.close()
