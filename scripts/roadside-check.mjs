#!/usr/bin/env node
// How wide is every model really, and does any of it end up over the road?
//
//   just dev coast                            # the dev server has to be up; this drives it
//   node scripts/roadside-check.mjs --write    # re-measure: writes src/render/extents.json
//   node scripts/roadside-check.mjs            # check only; non-zero if anything is in the road
//   node scripts/roadside-check.mjs --v        # the whole table, not just the offenders
//
// WHY THIS EXISTS. Trees and diners kept ending up in the road, three separate times, and each time
// the fix was a hand-typed offset that was right for the asset in front of me and wrong for the
// next one. Offsets are derived now — `sideOffset` in render/models.ts takes the model's width and
// refuses to put it over the tarmac — but a derived offset is only as good as the width it derives
// from, and those widths were typed by a human looking at a picture. Every single one was wrong:
// the palm by a factor of two, the arch by sixteen, the grandstand wrong the other way.
//
// So the widths are MEASURED, here, and written to `extents.json` for the game to read. The bake is
// the only thing that knows how wide a model really is, because it is the thing that scales it to
// its `heightM` and stands it on its feet.
//
// TWO WIDTHS, because a palm is not a diner. `footM` is the part touching the ground — the trunk,
// the posts — and it must clear the tarmac entirely. `silhouetteM` is everything — the crown, the
// lamp arm, the billboard's board — and it is allowed over the tarmac edge by `OVERHANG_MAX`,
// because a coast road with no fronds over it is not the coast road this game is about.

import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const URL_BASE = process.env.BAKE_URL ?? 'http://localhost:5182'
const argv = process.argv.slice(2)
const verbose = argv.includes('--v')
const write = argv.includes('--write')
const EXTENTS = 'apps/coast/src/render/extents.json'

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 640, height: 400 } })
page.on('pageerror', (e) => console.error('[pageerror]', e.message))

// The smallest plan the manifest fits: extents are measured off the geometry, not off the pixels,
// so the cell size changes nothing here and a quarter-scale bake is far quicker.
await page.goto(`${URL_BASE}/bake.html?size=2048&cell=0.25`, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForFunction(() => window.__atlas || window.__atlasError, null, { timeout: 600000 })
const err = await page.evaluate(() => window.__atlasError)
if (err) {
  console.error('bake failed:', err)
  await browser.close()
  process.exit(1)
}

const measured = Object.fromEntries(
  (await page.evaluate(() => window.__atlas.kinds))
    .map(([k, v]) => [k, { silhouetteM: Math.round(v.extentM.x * 100) / 100, depthM: Math.round(v.extentM.z * 100) / 100, footM: Math.round(v.footM.x * 100) / 100 }])
    .sort((a, b) => a[0].localeCompare(b[0])),
)

if (write) {
  const doc = {
    note: 'MEASURED, NOT TYPED. Regenerate with `node scripts/roadside-check.mjs --write` after changing a model or its heightM. silhouetteM/footM are metres about the point the sprite stands on; see scripts/roadside-check.mjs.',
    kinds: measured,
  }
  writeFileSync(EXTENTS, JSON.stringify(doc, null, 2) + '\n')
  console.log(`wrote ${EXTENTS}: ${Object.keys(measured).length} kinds`)
}

// The report reads `extents.json` back through the app's own `sideOffset`, so it has to run AFTER
// the write — and the write is a source edit, which sends vite's HMR through the baking page and
// destroys its context. So the check runs in a second page on a URL that is served by the dev
// server (same origin, so `import('/src/...')` resolves) but does not itself start a bake.
await page.close()
const checker = await browser.newPage()
await checker.goto(`${URL_BASE}/assets/LICENSES.md`, { waitUntil: 'domcontentloaded', timeout: 60000 })
const report = await checker.evaluate(async (m) => {
  const { SCENES, PALETTE } = await import('/src/world/scenes.ts')
  const { MODEL_BY_KIND, sideOffset, ROAD_CLEARANCE, OVERHANG_MAX } = await import('/src/render/models.ts')
  const { ROAD_HALF_WIDTH } = await import('/src/sim/Tuning.ts')

  /** Every (kind, offset, scale) the compiler can produce, and where it came from. */
  const placements = []
  for (const scene of Object.values(SCENES)) {
    // The closest roll at the largest jitter is the worst case the scatter can reach.
    for (const r of scene.theme.roadside) placements.push({ kind: r.kind, want: r.minOffset, scale: (r.scale ?? 1) * 1.15, from: `${scene.id} scenery` })
    for (const k of scene.theme.landmarks) placements.push({ kind: k, want: 0, scale: 1, from: `${scene.id} landmark` })
  }
  for (const group of PALETTE ?? []) {
    for (const e of group.kinds ?? []) {
      if (e.offset === undefined) continue
      placements.push({ kind: e.kind, want: e.offset, scale: e.scale ?? 1, from: `palette ${group.group}` })
    }
  }

  const rows = new Map()
  for (const p of placements) {
    if (MODEL_BY_KIND[p.kind]?.straddle) continue // placed over the centreline on purpose
    const e = m[p.kind]
    if (!e) continue
    const offset = sideOffset(p.kind, p.want, p.scale)
    const edge = offset * ROAD_HALF_WIDTH - ROAD_HALF_WIDTH
    const row = {
      kind: p.kind,
      silhouetteM: e.silhouetteM,
      footM: e.footM,
      offset,
      // Daylight between the tarmac edge and the nearest part of the thing. Negative is over the road.
      footClear: edge - (e.footM * p.scale) / 2,
      spanClear: edge - (e.silhouetteM * p.scale) / 2,
      from: p.from,
    }
    const prev = rows.get(p.kind)
    if (!prev || row.footClear < prev.footClear) rows.set(p.kind, row)
  }
  return { rows: [...rows.values()], clearance: ROAD_CLEARANCE, overhang: OVERHANG_MAX, half: ROAD_HALF_WIDTH }
}, measured)

await browser.close()

const rows = report.rows.sort((a, b) => a.footClear - b.footClear)
// A foot on the tarmac is a fault. A silhouette over it by more than the allowance is a fault too.
const bad = rows.filter((r) => r.footClear < 0 || r.spanClear < -report.overhang - 0.05)

const pad = (s, n) => String(s).padEnd(n)
const num = (v, n = 6) => v.toFixed(2).padStart(n)
console.log(`\nroad half-width ${report.half} m · foot must clear by ${report.clearance} m · silhouette may overhang by ${report.overhang} m\n`)
console.log(`${pad('kind', 16)}${pad('silhouette', 12)}${pad('foot', 8)}${pad('offset', 9)}${pad('foot clr', 10)}${pad('span clr', 10)}worst placement`)
for (const r of verbose ? rows : bad) {
  console.log(`${pad(r.kind, 16)}${num(r.silhouetteM, 10)}  ${num(r.footM, 6)}  ${num(r.offset, 7)}  ${num(r.footClear, 8)}  ${num(r.spanClear, 8)}  ${r.from}`)
}

if (bad.length) console.log(`\n${bad.length} kind(s) reach over the road.`)
else console.log(`\nall ${rows.length} placed kinds stand clear of the road.`)
process.exit(bad.length ? 1 : 0)
