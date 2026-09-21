import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('---\n' + m.text().slice(0, 2500)) })
await page.goto('http://127.0.0.1:5185/#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('d'); await page.waitForTimeout(3000)
await browser.close()
