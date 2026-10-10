// The trees tab (F6 → trees): do the knobs actually move the trees?
//   PORT=5185 node probes/corridor-treeknobs.mjs [slug]
// Planting knobs replant around the eye; shape knobs regrow the ez-tree species models and
// re-bake the impostor atlas. Both are debounced in scene.ts retune, so this waits for them.
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const PORT = process.env.PORT ?? '5185'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const p = await b.newPage({ viewport: { width: 800, height: 500 } })
const errs = []
p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)))
await p.route('**/@vite/client', (r) => r.abort())
await p.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await p.waitForTimeout(3000)
let fails = 0
const ok = (what, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`); if (!cond) fails++ }
const set = async (name, v) => p.evaluate(({ name, v }) => window.corridor.tune.set(name, v), { name, v })
const settle = async (ms = 2500) => p.waitForTimeout(ms)
/** trees near the middle of the spine, and what the near models look like */
const state = async () => p.evaluate(() => {
  const site = window.corridor.site, m = site.manifest
  const mid = m.spine.coords[Math.floor(m.spine.coords.length / 2)]
  const near = site.treesNear(mid[0], -mid[1], 250)
  let leafVerts = 0, branchVerts = 0, variants = 0
  site.layers.trees.traverse((o) => {
    if (!o.isInstancedMesh || !/near-tree/.test(o.name)) return
    const n = o.geometry.getAttribute('position')?.count ?? 0
    if (/leaves|leaf/i.test(o.name) || o.material?.alphaTest > 0) leafVerts += n
    else branchVerts += n
    variants++
  })
  return { planted: site.treePlanting(), near: near.length, leafVerts, branchVerts, variants, palette: site.treePalette().map((x) => x.id) }
})
// WARM UP FIRST. The load-time planting happens while the 2 m canopy tiles are still streaming,
// so it sees the 8 m overview and plants fewer trees than the steady state; the first replant
// after the tiles land legitimately finds more. Force one replant, then measure.
await set('TREE_CELL_M', 12); await settle()
await set('TREE_CELL_M', 6); await settle()
const base = await state()
console.log('baseline (after one replant):', JSON.stringify(base))
// --- planting -----------------------------------------------------------------------------
await set('TREE_CELL_M', 12); await settle()
const coarse = await state()
ok('TREE_CELL_M 6 -> 12 thins the wood about four-fold', coarse.near < base.near * 0.45 && coarse.near > base.near * 0.10, `${base.near} -> ${coarse.near} trees within 250 m`)
await set('TREE_CELL_M', 6); await settle()
await set('TREE_DENSITY', 0.5); await settle()
const half = await state()
ok('TREE_DENSITY 0.5 halves it', half.near < base.near * 0.7 && half.near > base.near * 0.3, `${base.near} -> ${half.near}`)
await set('TREE_DENSITY', 1); await settle()
await set('TREE_MIN_H', 12); await settle()
const tall = await state()
ok('TREE_MIN_H 12 keeps only the tall ones', tall.near < base.near, `${base.near} -> ${tall.near}`)
await set('TREE_MIN_H', 3); await settle()
const back = await state()
ok('putting the knobs back puts the trees back', Math.abs(back.near - base.near) <= Math.max(3, base.near * 0.05), `${base.near} -> ${back.near}`)
// --- shape --------------------------------------------------------------------------------
await set('TREE_LEAF_COUNT', 2.5); await settle(4000)
const leafy = await state()
ok('TREE_LEAF_COUNT regrows the models with more leaves', leafy.leafVerts > base.leafVerts * 1.4, `${base.leafVerts} -> ${leafy.leafVerts} leaf vertices`)
await set('TREE_LEAF_COUNT', 1); await settle(4000)
await set('TREE_DETAIL', 1.8); await settle(4000)
const detailed = await state()
ok('TREE_DETAIL regrows the branches with more sections', detailed.branchVerts > base.branchVerts * 1.2, `${base.branchVerts} -> ${detailed.branchVerts} branch vertices`)
await set('TREE_DETAIL', 1); await settle(4000)
// --- palette ------------------------------------------------------------------------------
await set('TREE_SPECIES', 0); await settle(4000)
const one = await state()
ok('TREE_SPECIES 0 forces a single species', one.palette.length === 1, `${JSON.stringify(base.palette)} -> ${JSON.stringify(one.palette)}`)
await set('TREE_SPECIES', -1); await settle(4000)
const mixed = await state()
ok('back to -1 restores the site mix', mixed.palette.length === base.palette.length, JSON.stringify(mixed.palette))
ok('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '))
console.log(fails ? `FAIL ${fails}` : 'PASS')
await b.close()
process.exit(fails ? 1 : 0)
