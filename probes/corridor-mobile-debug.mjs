import { chromium, devices } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ ...devices['Pixel 7'] })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() !== 'log' && m.type() !== 'debug') console.log(`console.${m.type()}: ${m.text().slice(0, 200)}`) })
page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`))
await page.goto('http://127.0.0.1:5185/#braddock-i70', { waitUntil: 'load' })
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(5000)
  const st = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, rows: document.querySelectorAll('#info table tr').length, pad: getComputedStyle(document.querySelector('#drivepad')).display }))
  console.log(i * 5 + 5, 's', JSON.stringify(st))
  if (st.status === '' && st.rows > 0) break
}
await page.screenshot({ path: '/tmp/claude-1000/-workspaces-apex-conduit/397fba92-5e84-41c5-9605-5d43678842ec/scratchpad/mobile_debug.png' })
await browser.close()
