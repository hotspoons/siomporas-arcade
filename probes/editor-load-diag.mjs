import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-crownsville'
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 900, height: 600 } })
await p.route('**/@vite/client', (r) => r.abort())
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
p.on('requestfailed', (r) => console.log('REQFAIL', r.url().slice(-60), r.failure()?.errorText))
const t0 = Date.now()
await p.goto(`http://localhost:5207/editor.html#${slug}`, { waitUntil: 'load' })
for (let i = 0; i < 30; i++) {
  await p.waitForTimeout(15000)
  const s = await p.evaluate(() => ({ st: document.querySelector('#status')?.textContent, site: !!window.corridor?.site }))
  console.log(`${Math.round((Date.now() - t0) / 1000)}s  status=${JSON.stringify(s.st)}  site=${s.site}`)
  if (s.site) break
}
await b.close()
