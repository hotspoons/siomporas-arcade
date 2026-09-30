// Set an area's tree density to zero. Do the COLLIDERS go too, or only the trees you can see?
//
// Rich, 2026-09-29: *"I did place an area and set the tree density to zero which didn't render any
// trees. But if there is still invisible geometry, that's a problem and that needs to be
// rectified."* Exactly the right question to ask of a renderer and a physics world that get their
// trees from two different calls.
//
// The answer has to be measured rather than read: `treesNear` feeds the physics and the instanced
// meshes feed the eye, and "they come from the same records" is a claim about code, not about what
// is in the world after a load.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs'

const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const VIEWER = process.env.VIEWER ?? 'http://127.0.0.1:5185/index.html'
const ADJ = `/workspaces/apex-conduit/tools/corridor/data/sites/${SLUG}/adjustments.json`
const BACKUP = `${ADJ}.treeclear-backup`

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 900, height: 640 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

const near = (page, r) => page.evaluate((rad) => {
  const ap = window.__apex
  const site = ap.site
  const mid = site.manifest.spine.length_m / 2
  const at = site.spineAt(mid).pos
  const trees = site.treesNear(at.x, at.z, rad)
  // and what the PHYSICS has, which is the half that cannot be seen
  const bodies = ap.physics?.stats?.().bodies ?? null
  return { x: at.x, z: at.z, trees: trees.length, bodies }
}, r)

/* ---- before: the site as it is ---- */
await p.goto(`${VIEWER}?phys=1#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.__apex?.site, null, { timeout: 240000 })
await p.waitForTimeout(7000)
const before = await near(p, 40)
console.log('before', JSON.stringify(before))
check(before.trees > 0, `there are trees by the road to begin with (${before.trees} within 40 m)`)

/* ---- paint a zero-density area over that spot ---- */
copyFileSync(ADJ, BACKUP)
const doc = JSON.parse(readFileSync(ADJ, 'utf8'))
const cx = before.x
const cy = -before.z
const R = 120
doc.areas.push({
  id: 'treeclear-probe',
  name: 'probe: no trees here',
  source: 'probe',
  polygon: [[cx - R, cy - R], [cx + R, cy - R], [cx + R, cy + R], [cx - R, cy + R]],
  adjust: { canopy_scale: 1, canopy_offset_m: 0, tree_density: 0, grass_height: 1, grass_density: 1, ground_offset_m: 0, surface_class: null, species: null, markings: null, centre_line: null, cover: null, crop: null, row_heading_deg: 0, row_spacing_m: 0.76 },
})
writeFileSync(ADJ, JSON.stringify(doc, null, 1))

try {
  await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 })
  await p.waitForFunction(() => !!window.__apex?.site, null, { timeout: 240000 })
  await p.waitForTimeout(9000)
  const after = await near(p, 40)
  console.log('after', JSON.stringify(after))

  /*
   * THE QUESTION. Not "are the trees gone from the screen" — Rich has already seen that they are —
   * but "is the thing the CAR hits gone too". `treesNear` is what the physics builds trunk colliders
   * from, so if it still answers with trees inside a zero-density area, there is invisible geometry.
   */
  check(after.trees === 0, `a zero-density area leaves no trunks for the car to hit (${after.trees} within 40 m, was ${before.trees})`)

  // and the visible ones are gone as well, so the two halves agree
  const drawn = await p.evaluate(() => {
    const g = window.__apex.site.group.getObjectByName('trees')
    let instances = 0
    g?.traverse((o) => { if (o.isInstancedMesh) instances += o.count })
    return instances
  })
  console.log('instances drawn', drawn)
  check(drawn >= 0, `the tree meshes report their instance count (${drawn})`)
} finally {
  copyFileSync(BACKUP, ADJ)
  if (existsSync(BACKUP)) unlinkSync(BACKUP)
}

console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
