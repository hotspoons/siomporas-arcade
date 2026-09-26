// How dense are the trees, and how dense SHOULD they be?
//
// Rich, 2026-09-26: "trees still seem sparser in the crownsville and Crofton worlds than the
// arrowhead farms world where I live." This measures both halves of that: the trees actually
// planted per km2 near a point, and the canopy the site's own CHM says is there — so the answer
// is a ratio, not an impression.
//   PORT=5185 node probes/corridor-treedensity.mjs <slug> [radius_m]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const R = Number(process.argv[3] ?? 300)
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 700, height: 450 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForTimeout(4000)
const out = await page.evaluate((R) => {
  const site = window.corridor.site, m = site.manifest
  // the measuring point: the middle of the spine. The trees are planted around the EYE, so put
  // the eye there first — exactly what driving does — and let the replant happen.
  const sp = m.spine.coords, mid = sp[Math.floor(sp.length / 2)]
  const [px, py] = [mid[0], mid[1]]
  const THREE = window.corridor.THREE
  const eye = new THREE.Vector3(px, (site.groundAt(px, -py) ?? 0) + 2, -py)
  site.updateNear(eye, 0, new THREE.Vector3(1, 0, 0), 0)
  // trees planted within R
  let n = 0, hSum = 0
  // treesNear is the Site's own collision query: [x, z, radius] within r of a point
  for (const r of site.treesNear(px, -py, R)) { n++; hSum += r[2] / 0.025 }
  // canopy the CHM says is there, on a 4 m grid
  let cells = 0, canopyCells = 0
  for (let dy = -R; dy <= R; dy += 4) for (let dx = -R; dx <= R; dx += 4) {
    if (Math.hypot(dx, dy) > R) continue
    cells++
    if (site.canopyAt(px + dx, py + dy) >= 3) canopyCells++
  }
  const areaKm2 = (Math.PI * R * R) / 1e6
  const canopyKm2 = areaKm2 * (canopyCells / Math.max(1, cells))
  return {
    slug: m.slug,
    chm: m.layers.chm ? { file: m.layers.chm.file, res: m.layers.chm.res } : null,
    tileChmRes: m.layers.tiles?.res?.chm ?? null,
    treesTotal: site.treeCount,
    withinR: n,
    treesPerKm2: Math.round(n / areaKm2),
    canopyShare: +(canopyCells / Math.max(1, cells)).toFixed(2),
    treesPerCanopyKm2: canopyKm2 > 0 ? Math.round(n / canopyKm2) : null,
    impliedCellM: canopyKm2 > 0 && n > 0 ? +Math.sqrt((canopyKm2 * 1e6) / n).toFixed(1) : null,
    meanHeight: +(hSum / Math.max(1, n)).toFixed(1),
    planting: site.treePlanting ? site.treePlanting() : null,
  }
}, R)
console.log(JSON.stringify(out))
await browser.close()
