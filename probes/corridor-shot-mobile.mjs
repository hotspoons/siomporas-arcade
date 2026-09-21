import { chromium, devices } from 'playwright'
const [,, url, out, mode = 'photo'] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const ctx = await browser.newContext({ ...devices['Pixel 7'] })
const page = await ctx.newPage()
const logs = []
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
await page.goto(url, { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && document.querySelectorAll('#info table tr').length > 0, null, { timeout: 180000 })
if (mode === 'drive') { await page.tap('#drivepad button[data-act="drive"]'); await page.waitForTimeout(1500) }
if (mode === 'panel') await page.tap('#toggle')
await page.waitForTimeout(3000)
await page.screenshot({ path: out, timeout: 180000 })
console.log(logs.join('\n') || 'no page errors')
await browser.close()
