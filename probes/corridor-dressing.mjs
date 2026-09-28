// Does the dressing actually land on the buildings?
//
// `dressing.test.ts` proves the PLAN — where each part goes, in metres, headlessly. This proves
// the other half: that the plan reaches the scene as geometry, in the right place, on a real bake.
// The two failures it exists for are the ones a unit test cannot see — the kit JSON not reaching
// the bundle at all, and every part landing inside the walls where nothing is visible.
//
//   node probes/corridor-dressing.mjs shots/dressing.png
import { chromium } from 'playwright'

const out = process.argv[2] ?? 'shots/dressing.png'
const url = process.env.PROBE_URL ?? 'http://localhost:5185/?lite#arrowhead-farms'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(6000)
await page.keyboard.press('Enter') // the grader only runs once the world is being looked at

// arrowhead-farms, not crofton-triangle: 59 buildings against 7506. Under SwiftShader the big
// site takes ~110 s to grade its first cell and then crashes the tab on the screenshot, and what
// is being measured here — does the kit reach the bundle and land outside the walls — is the same
// on either. `?lite` for the same reason.
//
// the buildings are graded in, so wait for the mesh rather than a fixed sleep
await page.waitForFunction(() => {
  const a = window.__apex
  if (!a?.scene) return false
  let n = 0
  a.scene.traverse((o) => { if (o.name === 'buildings:massing') n += 1 })
  return n > 0
}, null, { timeout: 240000 })  // ~110 s to grade the first cell under swiftshader
await page.waitForTimeout(4000)

const report = await page.evaluate(() => {
  const a = window.__apex
  const THREE = a.THREE
  const massing = []
  const dressing = []
  a.scene.traverse((o) => {
    if (o.name === 'buildings:massing') massing.push(o)
    if (o.name === 'buildings:dressing') dressing.push(o)
  })
  const tris = (list) => list.reduce((t, m) => t + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0)
  // where the dressing sits relative to the massing: if the two boxes do not overlap, the parts
  // are somewhere else entirely, and if the dressing box is inside the massing box by more than a
  // wall thickness, every window is buried
  const bbox = (list) => {
    const b = new THREE.Box3()
    for (const m of list) b.expandByObject(m)
    return b.isEmpty() ? null : { min: b.min.toArray(), max: b.max.toArray() }
  }
  return {
    massingMeshes: massing.length,
    dressingMeshes: dressing.length,
    massingTris: tris(massing),
    dressingTris: tris(dressing),
    massingBox: bbox(massing),
    dressingBox: bbox(dressing),
  }
})

const fail = []
if (errs.length) fail.push('page errors: ' + errs.join(' | '))
if (!report.dressingMeshes) fail.push('no buildings:dressing mesh in the scene')
if (report.dressingTris < report.massingTris * 0.05) fail.push(`dressing is only ${report.dressingTris} tris against ${report.massingTris} of massing — the kit did not reach the bundle`)
if (report.dressingBox && report.massingBox) {
  const d = report.dressingBox
  const m = report.massingBox
  // the dressing must reach the outside of the walls, not sit inside them
  const outside = ['0', '2'].some((i) => d.min[+i] < m.min[+i] + 0.001 || d.max[+i] > m.max[+i] - 0.001)
  if (!outside) fail.push('the dressing box is strictly inside the massing box — every part is buried in a wall')
}

console.log(JSON.stringify(report, null, 1))
// the verdict is the measurement, not the picture: a swiftshader screenshot of a graded cell can
// take over 30 s and it must not be able to fail the probe
try {
  await page.screenshot({ path: out, timeout: 120000 })
  console.log('shot: ' + out)
} catch (e) {
  console.log('shot skipped: ' + e.message.split('\n')[0])
}
await browser.close()
if (fail.length) { console.log('FAIL: ' + fail.join('; ')); process.exit(1) }
console.log('PASS: dressing reaches the scene and stands proud of the walls')
