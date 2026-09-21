// Is a stub actually pavement all the way along, or does grass grow through the gaps?
// node probes/corridor-stubgrass.mjs <slug>
import { chromium } from 'playwright'
const [,, slug] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 640, height: 400 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 120)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:5185/#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((s) => window.corridor?.site?.manifest?.slug === s, slug, { timeout: 240000 })
await page.waitForTimeout(1500)
console.log(await page.evaluate(() => {
  const s = window.corridor.site, m = s.manifest
  const walk = (list, label) => {
    let pts = 0, off = 0, worst = -99
    for (const r of list ?? []) {
      const c = r.coords ?? []
      for (let i = 0; i < c.length - 1; i++) {
        // sample every metre along each segment: gaps between stations show up between points
        const a = c[i], b = c[i + 1]
        const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])))
        for (let k = 0; k <= n; k++) {
          const t = k / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t
          const d = s.edgeDistance(x, -y)
          pts++
          if (d > 0) { off++; if (d > worst) worst = d }
        }
      }
    }
    return `${label}: ${pts} samples, ${off} NOT pavement (${(100 * off / Math.max(1, pts)).toFixed(1)}%), worst +${worst.toFixed(2)} m`
  }
  return JSON.stringify({ stubs: walk(m.stubs, 'stubs'), driveways: walk(m.driveways, 'driveways') })
}))
await browser.close()
