// Why does the site not load? Every console line, every page error, every unhandled rejection,
// then what state the page reached after `seconds`.
//   PORT=5185 SECONDS=120 node probes/corridor-loadfail.mjs '<url>'
import { chromium } from 'playwright'
const [, , url] = process.argv
const SECONDS = Number(process.env.SECONDS ?? 120)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 560 } })
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
page.on('pageerror', (e) => console.log(stamp(), 'PAGEERROR', e.message.slice(0, 400)))
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning' || /fail|error|corridor/i.test(m.text())) console.log(stamp(), 'console.' + t, m.text().slice(0, 1800)) })
page.on('crash', () => console.log(stamp(), 'PAGE CRASHED'))
await page.addInitScript(() => { addEventListener('unhandledrejection', (e) => console.error('UNHANDLED', String(e.reason?.stack ?? e.reason).slice(0, 500))) })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
console.log(stamp(), 'domcontentloaded')
const deadline = Date.now() + SECONDS * 1000
while (Date.now() < deadline) {
  await page.waitForTimeout(10000)
  const st = await page.evaluate(() => ({ toast: document.querySelector('.toast')?.textContent?.slice(0, 100) ?? null, site: !!window.corridor?.site })).catch((e) => ({ evalError: e.message.slice(0, 120) }))
  console.log(stamp(), JSON.stringify(st))
  if (st.site) break
}
await browser.close()
