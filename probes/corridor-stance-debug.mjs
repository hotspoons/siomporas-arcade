import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)))
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 300)) })
const st = { v: 1, site: 'braddock-i70', season: 'summer', mode: 'drive', layers: { imagery: true, trees: true, road: true }, lite: true, car: { p: [-1.28, 185.37, -0.59], yaw: 0.9993, speed: 0, look: [-1.1, -0.15] } }
await page.goto('http://127.0.0.1:5185/?lite&season=summer&stance=' + Buffer.from(JSON.stringify(st)).toString('base64') + '#braddock-i70', { waitUntil: 'load' })
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(5000)
  const s = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, ready: !!window.corridor }))
  console.log(i * 5, JSON.stringify(s))
  if (s.status === '' && s.ready) break
}
await browser.close()
