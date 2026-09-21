import { chromium } from 'playwright'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(m.type(), m.text().slice(0, 300)) })
await page.goto('http://127.0.0.1:5185/#braddock-i70', { waitUntil: 'load' })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor, null, { timeout: 180000 })
await page.keyboard.press('d'); await page.waitForTimeout(2000)
const info = await page.evaluate(() => {
  const s = window.corridor.site
  const imp = s.layers.trees.getObjectByName('impostors')
  const near = s.layers.trees.getObjectByName('near-trees')
  const m = new Array(16); imp.getMatrixAt(5, { fromArray: () => {}, elements: m, toArray: (a) => a } )
  const arr = imp.instanceMatrix.array
  return { impCount: imp.count, capacity: imp.instanceMatrix.count, sample: Array.from(arr.slice(5 * 16, 5 * 16 + 16)).map((v) => +v.toFixed(2)), variant: imp.geometry.attributes.aVariant.array[5], nearCounts: near.children.map((c) => c.count), atlas: imp.material.uniforms.atlas.value?.image ? [imp.material.uniforms.atlas.value.image.width, imp.material.uniforms.atlas.value.image.height] : null, extents: undefined }
})
console.log(JSON.stringify(info))
await browser.close()
