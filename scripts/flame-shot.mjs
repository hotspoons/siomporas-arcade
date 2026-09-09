// A close look at the afterburner: drives with the boost lit and screenshots just the car, scaled up.
// Anchoring the flames to the exhausts is a few pixels' worth of judgement at normal size.
import { chromium } from 'playwright'
const out = process.env.OUT || 'shots/model/flames.png'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 900, height: 520 } })
page.on('pageerror', e => console.log('[err]', e.message))
await page.goto(process.env.URL || 'http://localhost:5182/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await page.keyboard.press('Enter')
await page.waitForTimeout(400)
await page.keyboard.down('KeyW')
await page.keyboard.down('Space')
if (process.env.STEER) await page.keyboard.down(process.env.STEER)
await page.waitForTimeout(4000)
// The car sits at the middle of the screen, low; clip tight around it and let the PNG be scaled up.
await page.screenshot({ path: out, clip: { x: 330, y: 350, width: 260, height: 150 }, scale: 'css' })
await page.keyboard.up('Space')
await page.keyboard.up('KeyW')
await browser.close()
console.log('shot', out)
