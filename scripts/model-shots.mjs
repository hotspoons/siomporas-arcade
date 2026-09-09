// Shoots the hero car from every angle the sprite atlas bakes, plus a close pass on the door.
// Judging a shape from a 40-pixel sprite is hopeless; these are the same meshes under the same
// lights, big. Needs coast's dev server up (`just dev coast`), writes PNGs into $OUT.
//
//   just model-shots            # → shots/model/*.png
import { chromium } from 'playwright'
const out = process.env.OUT || '/tmp/shots'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 900, height: 620 } })
page.on('pageerror', e => console.log('[err]', e.message))
await page.goto('http://localhost:5182/model.html', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
await page.uncheck('[data-spin]')
for (const view of ['rear', '3/4 rear', 'flank', '3/4 front', 'front', 'from above']) {
  await page.getByRole('button', { name: view, exact: true }).click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${out}/${view.replace(/[^a-z0-9]/gi, '') || 'v'}.png` })
}
// A close pass on the door, to see the roundel and its number the way it is painted.
await page.evaluate(() => {
  const a = window.__model
  if (!a) return
  a.camera.position.set(2.4, 0.55, 1.0)
  a.controls.target.set(0.9, 0.28, 0.3)
  a.controls.update()
})
await page.waitForTimeout(500)
await page.screenshot({ path: `${out}/door.png` })
await browser.close()
console.log('done')
