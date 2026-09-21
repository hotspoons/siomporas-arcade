import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.goto('http://127.0.0.1:5185/?lite#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('Tab')
const r = await page.evaluate(() => {
  const { drive, site } = window.corridor
  const car = drive.car
  const log = []
  const input = { throttle: 1, brake: 0, steer: 0, handbrake: false }
  for (let i = 0; i < 600; i++) {
    car.tick(1 / 120, input)
    if (i % 60 === 0 || car.event === 'bump') log.push({ t: (i / 120).toFixed(1), mph: (car.speed * 2.237).toFixed(0), grass: car.onGrass, ev: car.event, edge: site.edgeDistance(car.pos.x, car.pos.z).toFixed(1), y: car.pos.y.toFixed(1), trees: site.treesNear(car.pos.x, car.pos.z, 4).length })
  }
  return log.slice(0, 20)
})
console.log(JSON.stringify(r))
await browser.close()
