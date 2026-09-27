// Does every road know it is a road?
//
// The viewer keeps a distance-to-pavement field built from stations laid every 5 m along each
// carriageway. Grass, trees, the verge, the car's on-road test and the road-name readout all ask
// it. On 2026-09-27 one road on crofton-triangle — Riedel Road, 2,515 m of tertiary — had
// stations for only its first 272 m, because `recurve` read `branchRaw.length - 1` when it RAN
// rather than when it was pushed and so wrote every re-graded branch's length into the LAST
// branch's entry. The asphalt was drawn full length. The field answered "+57 m to the nearest
// road" while you stood on it, and grass grew straight through it.
//
// Nothing caught that, because every other road was fine and nobody drives all of them. This
// walks EVERY carriageway's own centreline and asserts the field agrees it is pavement there.
// It is three seconds of work and it would have failed loudly the day it regressed.
//
//   PORT=5185 node probes/corridor-fieldcoverage.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 700, height: 450 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForTimeout(3000)

const out = await page.evaluate(() => {
  const site = window.corridor.site
  const m = site.manifest
  const d = (x, z) => site.edgeInfo(x, z, undefined, true).d
  // CONTROL: the spine. If the field cannot say "pavement" on the site's main road, the probe is
  // measuring nothing and a clean result on the branches would mean nothing either.
  let spineOn = 0
  let spineN = 0
  for (let s = 0; s <= m.spine.length_m; s += Math.max(25, m.spine.length_m / 40)) {
    const p = site.spineAt(s).pos
    spineN++
    if (d(p.x, p.z) < 0) spineOn++
  }
  // every branch, along its own centreline
  const bad = []
  let roads = 0
  let sampled = 0
  let covered = 0
  for (const br of m.branches ?? []) {
    const pts = br.coords ?? br.points ?? null
    if (!pts || pts.length < 2) continue
    roads++
    let on = 0
    let n = 0
    // the manifest's own coordinates, so this does not depend on the curve the viewer built
    const step = Math.max(1, Math.floor(pts.length / 25))
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i]
      const x = p[0]
      const z = -p[1]
      n++
      if (d(x, z) < 0) on++
    }
    sampled += n
    covered += on
    const share = on / n
    if (share < 0.6) bad.push({ id: br.id, name: br.name ?? br.ref ?? null, highway: br.highway ?? null, points: pts.length, sampled: n, onPavement: on, share: +share.toFixed(2) })
  }
  bad.sort((a, b) => a.share - b.share)
  return { roads, sampled, covered, share: +(covered / Math.max(1, sampled)).toFixed(3), bad: bad.slice(0, 8), badN: bad.length, control: { spineN, spineOn } }
})
console.log(JSON.stringify(out, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (!out.roads) fail('no branches with coordinates — nothing was measured')
else if (!(out.control.spineOn > out.control.spineN * 0.8)) fail(`the field reports pavement at only ${out.control.spineOn} of ${out.control.spineN} points on the SPINE's own centreline — the field is broken everywhere, or this probe is asking it wrong`)
else if (out.badN) fail(`${out.badN} road(s) have a centreline the distance field mostly does not think is pavement — e.g. ${JSON.stringify(out.bad[0])}`)
else console.log(`PASS: ${out.roads} roads, ${out.covered}/${out.sampled} centreline samples (${(out.share * 100).toFixed(1)}%) land on pavement; no road is missing its stations`)
