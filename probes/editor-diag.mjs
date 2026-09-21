import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'frederick-i70'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('console', (m) => console.log(`${m.type()}: ${m.text()}`))
p.on('pageerror', (e) => console.log(`PAGEERROR: ${e.message}\n${e.stack?.split('\n').slice(0,6).join('\n')}`))
p.on('requestfailed', (r) => console.log(`REQFAIL ${r.url()} ${r.failure()?.errorText}`))
await p.goto(`http://localhost:5185/editor.html#${slug}`, { waitUntil: 'load' })
for (let i = 0; i < 24; i++) {
  await p.waitForTimeout(10000)
  const s = await p.evaluate(() => ({ status: document.querySelector('#status')?.textContent, site: !!window.corridor?.site }))
  console.log(`t=${(i + 1) * 10}s status=${JSON.stringify(s.status)} site=${s.site}`)
  if (s.site && s.status === '') break
}
await b.close()
