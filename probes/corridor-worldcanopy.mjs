// Does a WORLD bake have trees away from its roads?
//
// Rich, 2026-09-27: "proximity to a road shouldn't really dictate tree mappings and ground
// textures — let's build the full world out for a given network."
//
// The corridor clip was only half of it. `network_tiles.py` has read a file called
// `canopy_global.tif` for a while, with a comment explaining that a network bake rasterises lidar
// only in a band along its roads and that outside that band "no lidar" was written as "0 m
// canopy" — which the tree planter reads as "no trees". NOTHING HAS EVER WRITTEN THAT FILE, so
// the fill it describes had never run.
//
// This measures the thing that matters rather than the plumbing: stand a long way from every
// road, and ask whether the world knows there is a wood there.
//
//   PORT=5185 node probes/corridor-worldcanopy.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-world'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 900000 })
await page.waitForTimeout(6000)

const out = await page.evaluate(async () => {
  const site = window.corridor.site
  const THREE = window.corridor.THREE
  const m = site.manifest
  const bb = m.bbox
  // bands of distance from the nearest road, so "near" and "far" are measured and not assumed
  const band = (lo, hi, want) => {
    const pts = []
    for (let k = 0; k < 40000 && pts.length < want; k++) {
      const x = bb[0] + Math.random() * (bb[2] - bb[0])
      const y = bb[1] + Math.random() * (bb[3] - bb[1])
      const d = site.edgeInfo(x, -y).d
      if (d >= lo && d < hi) pts.push([x, y])
    }
    return pts
  }
  const stat = async (pts) => {
    let withCanopy = 0
    let sum = 0
    for (const [x, y] of pts) {
      const c = site.canopyAt(x, y) ?? 0
      if (c >= 3) withCanopy++
      sum += c
    }
    return { n: pts.length, withCanopy, share: pts.length ? +(withCanopy / pts.length).toFixed(3) : 0, meanM: pts.length ? +(sum / pts.length).toFixed(2) : 0 }
  }
  /*
   * THE FAR BAND IS CHOSEN FROM THE SITE, NOT FROM A NUMBER I LIKED.
   *
   * The first version asked for points at least 600 m from a road and found none — this world is
   * every drivable street over a suburban grid, and there is essentially nowhere that far out. A
   * fixed threshold turns "the site is denser than I assumed" into "nothing was measured". So the
   * distribution is sampled first and the far band is its top decile, whatever that happens to be.
   */
  const sample = []
  for (let k = 0; k < 20000 && sample.length < 3000; k++) {
    const x = bb[0] + Math.random() * (bb[2] - bb[0])
    const y = bb[1] + Math.random() * (bb[3] - bb[1])
    const d = site.edgeInfo(x, -y).d
    if (Number.isFinite(d) && d > 0) sample.push(d)
  }
  sample.sort((a, b) => a - b)
  const p90 = sample.length ? sample[Math.floor(sample.length * 0.9)] : 0
  const maxD = sample.length ? sample[sample.length - 1] : 0
  const near = band(5, 60, 300)
  const far = band(p90, 1e9, 300)
  // and trees actually planted out there: put the eye in the far band and count
  let treesFar = null
  if (far.length) {
    /*
     * MOVE THE CAMERA, NOT AN EYE OF MY OWN.
     *
     * The trees follow the eye -- TREE_PLANT_RADIUS_M of them are planted around it and replanted
     * once it has moved TREE_REPLANT_M -- and the app's frame loop calls updateNear with the real
     * camera every frame. A probe that calls updateNear itself with a borrowed eye therefore
     * replants to its point and is immediately replanted back to the camera, and the first run of
     * this reported "0 trees 80 m from a road" at a point 3.9 km from a planting centre that had
     * never moved. Eighty replants had happened; all of them were to the camera.
     */
    const [fx, fy] = far[0]
    const cam = window.corridor.camera
    cam.position.set(fx, (site.groundAt(fx, -fy) ?? 0) + 2, -fy)
    window.corridor.orbit.target.set(fx + 30, site.groundAt(fx + 30, -fy) ?? 0, -fy)
    window.corridor.orbit.update()
    for (let k = 0; k < 90; k++) await new Promise((r) => requestAnimationFrame(r))
    /*
     * ASK THE PLANTER, not only the result. "0 trees here" has two very different causes -- the
     * world has no canopy out here, or the planter never moved -- and the difference is the whole
     * diagnosis. `treePlanting()` reports where the last plant was centred and how many it made.
     */
    const plant = site.treePlanting?.() ?? null
    treesFar = {
      at: [Math.round(fx), Math.round(fy)],
      within300m: site.treesNear(fx, -fy, 300).length,
      roadDist: +site.edgeInfo(fx, -fy).d.toFixed(0),
      canopyHere: +(site.canopyAt(fx, fy) ?? 0).toFixed(1),
      planting: plant,
      movedTo: plant?.centre ? +Math.hypot(plant.centre[0] - fx, plant.centre[1] - fy).toFixed(0) : null,
    }
  }
  return { farBandFrom: +p90.toFixed(0), furthestFromRoad: +maxD.toFixed(0), world: m.world === true, tiles: (m.layers?.tiles?.list?.length ?? m.layers?.tiles?.count ?? null), near: await stat(near), far: await stat(far), treesFar }
})
console.log(JSON.stringify(out, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (!out.world) fail(`${slug} is not a world bake — nothing here applies to it`)
else if (!out.near.n || !out.far.n) fail(`could not find points in both bands (near ${out.near.n}, far ${out.far.n}) — nothing was measured`)
// liveness: the site must have canopy SOMEWHERE, or a zero far from roads means nothing
else if (!(out.near.share > 0.1)) fail(`only ${(100 * out.near.share).toFixed(0)}% of points beside a road have canopy — this site has no canopy at all`)
// the point: a wood a kilometre from a road is still a wood
else if (!(out.far.share > out.near.share * 0.5)) fail(`canopy beside a road ${(100 * out.near.share).toFixed(0)}% against ${(100 * out.far.share).toFixed(0)}% at ${out.farBandFrom}m+ — the canopy still stops at the corridor`)
else if (!(out.treesFar?.within300m > 100)) fail(`only ${out.treesFar?.within300m} trees planted ${out.treesFar?.roadDist} m from the nearest road`)
else console.log(`PASS: canopy over 3 m on ${(100 * out.near.share).toFixed(0)}% of ground beside a road and ${(100 * out.far.share).toFixed(0)}% at ${out.farBandFrom} m or more from one (mean ${out.far.meanM} m, furthest anything gets on this site is ${out.furthestFromRoad} m); ${out.treesFar.within300m} trees planted ${out.treesFar.roadDist} m from the nearest road.`)
