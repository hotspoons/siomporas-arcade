#!/usr/bin/env node
// Does the tree LOD still pop? Walks the eye forward through the near/far boundary and counts,
// at each step, how many far trees CHANGED STATE since the last step — that number is the pop.
// With TREE_FADE_M = 0 a tree goes card -> model in one step; with a band it dissolves across
// several, so the same journey shows the same trees changing but never all at once.
//   node probes/tree-lod-fade.mjs [fadeM ...]
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const slug = args.find((a) => /^[a-z]/.test(a)) ?? 'frederick-i70'
const fades = args.filter((a) => /^[\d.]+$/.test(a)).map(Number)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
await page.route('**/@vite/client', (r) => r.abort())
page.on('pageerror', (e) => console.log('pageerror:', e.message))
await page.goto(`http://localhost:5207/#${slug}`, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.corridor?.site?.updateNear, null, { timeout: 300000 })
await page.waitForTimeout(1500)

for (const fade of fades.length ? fades : [0, 30]) {
  const r = await page.evaluate(async ({ fade }) => {
    const { site, tune, THREE } = window.corridor
    tune.set('TREE_FADE_M', fade)
    const imp = site.layers.trees.getObjectByName('impostors')
    if (!imp) return { err: 'no impostor mesh (site built without a renderer?)' }
    const aFade = imp.geometry.getAttribute('aFade')
    const count = imp.count
    const snap = () => {
      // state per instance: 0 = card hidden (near model has it), 1 = solid card, else partial
      const m = imp.instanceMatrix.array
      const out = new Float32Array(count)
      for (let i = 0; i < count; i++) out[i] = m[i * 16] === 0 ? 0 : aFade.array[i]
      return out
    }
    const len = site.manifest.spine.length_m
    const from = Math.round(len * 0.35)
    const to = Math.min(len - 20, from + 300)
    const steps = []
    let prev = null
    let inside = 0, outside = 0
    // walk 300 m along the road in 10 m steps: every tree at the boundary crosses it
    for (let s = from; s <= to; s += 10) {
      const at = site.spineAt(s)
      const fwd = at.dir.clone()
      site.updateNear(at.pos.clone().add(new THREE.Vector3(0, 1.4, 0)), 0, fwd, 0)
      const now = snap()
      // WHERE the dissolving cards are, relative to the swap boundary. This is the check that
      // matters and the one a "fewer hard switches" count cannot make: a card must dissolve
      // INSIDE the near radius, on top of the model that has already taken over. Dissolving it
      // outside means the tree fades to nothing and only then does the model appear — which
      // scores just as well on switch counts and looks worse than the pop it replaced.
      {
        const R = tune.get('TREE_NEAR_RADIUS')
        for (let i = 0; i < count; i++) {
          if (now[i] <= 0.01 || now[i] >= 0.99) continue
          // tree world position straight out of the instance matrix's translation columns —
          // `setVisible` zeroes the SCALE columns, never these, so they stay valid when hidden
          const m = imp.instanceMatrix.array
          const d = Math.hypot(m[i * 16 + 12] - at.pos.x, m[i * 16 + 14] - at.pos.z)
          if (d < R) inside++
          else outside++
        }
      }
      if (prev) {
        let hard = 0, soft = 0, partial = 0
        for (let i = 0; i < count; i++) {
          const d = Math.abs(now[i] - prev[i])
          if (d > 0.9) hard++          // a full card appeared or vanished in one step
          else if (d > 0.01) soft++    // it moved part way
          if (now[i] > 0.01 && now[i] < 0.99) partial++
        }
        steps.push({ s, hard, soft, partial })
      }
      prev = now
    }
    const sum = (k) => steps.reduce((a, x) => a + x[k], 0)
    const max = (k) => steps.reduce((a, x) => Math.max(a, x[k]), 0)
    return { len, from, to, n: count, steps: steps.length, hardTotal: sum('hard'), hardMax: max('hard'), softTotal: sum('soft'), partialMax: max('partial'), inside, outside }
  }, { fade })
  if (r.err) { console.log(r.err); break }
  console.log(`${slug}  TREE_FADE_M=${String(fade).padStart(3)}  s ${r.from}->${r.to}, ${r.steps} steps of 10 m, ${r.n} far trees:`)
  console.log(`   hard switches (card <-> model in ONE step): ${r.hardTotal} total, worst step ${r.hardMax}`)
  console.log(`   partial steps (dissolving):                 ${r.softTotal} total, most mid-fade at once ${r.partialMax}`)
  if (r.inside + r.outside > 0) {
    const ok = r.outside === 0
    console.log(`   dissolving cards INSIDE the near radius:    ${r.inside}   outside: ${r.outside}  ${ok ? 'OK (card melts off the model)' : 'WRONG DIRECTION (tree vanishes before the model arrives)'}`)
  }
}
await browser.close()
