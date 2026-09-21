import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
await page.goto('http://127.0.0.1:5185/?season=summer#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
// drive, look hard right at the embankment, hide the panel, capture the stance URL
await page.keyboard.press('Tab')
await page.evaluate(() => { const d = window.corridor.drive; d.yaw = -1.1; d.pitch = -0.15; d.car.speed = 0 })
await page.keyboard.press('m')
await page.waitForTimeout(1500)
await page.keyboard.press('c')
await page.waitForTimeout(500)
const url = await page.evaluate(() => location.href)
console.log('STANCE', url)
await page.screenshot({ path: process.argv[2] + '-a.png', timeout: 120000 })
// reload from the URL alone and shoot again: the two frames should match
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)))
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 200)) })
await page.goto('about:blank') // same URL but for the hash = a same-document navigation, no reload
await page.goto(url, { waitUntil: 'commit', timeout: 180000 }) // swiftshader makes a second load slow
for (let i = 0; i < 36; i++) {
  await page.waitForTimeout(5000)
  const st = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, ready: !!window.corridor }))
  console.log(i * 5, JSON.stringify(st))
  if (st.status === '' && st.ready) break
}
await page.waitForTimeout(2500)
await page.screenshot({ path: process.argv[2] + '-b.png', timeout: 120000 })
console.log(await page.evaluate(() => JSON.stringify({ drive: window.corridor.drive.on, yaw: window.corridor.drive.yaw, panelHidden: document.querySelector('#panel').classList.contains('hidden') })))
await browser.close()
