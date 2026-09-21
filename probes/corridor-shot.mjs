import { chromium } from 'playwright'
const [,, url, out, mode = 'photo'] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const logs = []
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
await page.goto(url, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && document.querySelectorAll('#info table tr').length > 0, null, { timeout: 180000 })
if (mode === 'top') await page.keyboard.press('h')
if (mode === 'drive') { await page.keyboard.press('Tab'); await page.keyboard.down('w'); await page.waitForTimeout(3500); await page.keyboard.up('w'); await page.waitForTimeout(800) }
await page.waitForTimeout(4000)
await page.screenshot({ path: out, timeout: 180000 })
console.log(logs.filter((l) => !l.startsWith('log:')).slice(0, 10).join('\n') || 'no console errors')
console.log(await page.textContent('#info'))
await browser.close()
