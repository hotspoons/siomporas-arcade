// Does an impostor card ever stand inside the tree it was meant to hand over to?
//
// Rich, 2026-09-27: "I see this occasionally - its impostors rendered over the actual tree, it
// isn't consistent and if I reload the scene it will render correctly."
//
// The far field draws one camera-facing quad per tree; the near set draws real models for the
// trees closest to the eye and the quad is hidden for exactly those — except across a dissolve
// band just inside the near radius, where BOTH are drawn on purpose so the model's arrival is
// hidden under a solid card that then melts off it. So the invariant is not "no tree has both",
// it is:
//
//     a near-set tree OUTSIDE the dissolve band must not have a visible card.
//
// `site.treeCards()` counts the violations off the instance matrices themselves. The bug only
// appeared after a REPLANT — the seat rewrites every matrix, making every card visible, while
// the cache of which ones were hidden went stale — so this probe drives, and a run that never
// replants proves nothing and fails.
//
// AND THE SECOND CAUSE, found when Rich reported it again on 2026-09-28: the counter above reads
// the CPU array, which was right while the screen was wrong. `refreshFar` cleared the attribute's
// pending upload ranges at its start, and it runs TWICE in a frame whenever a replant fires one
// and the near set then moves — so the first pass's hides were written to memory and never sent
// to the GPU. `uploads.marked` against `uploads.sent` is the half the matrices cannot show: they
// diverge by exactly the writes that were dropped.
//
//   PORT=5185 node probes/corridor-treecards.mjs [slug] [steps] [step_m]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'crofton-triangle'
const STEPS = Number(process.argv[3] ?? 40)
const STEP_M = Number(process.argv[4] ?? 60)
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 700, height: 450 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 600000 })
await page.waitForTimeout(4000)

const out = await page.evaluate(
  ({ STEPS, STEP_M }) => {
    const site = window.corridor.site
    const THREE = window.corridor.THREE
    if (!site.treeCards) return { error: 'no treeCards accessor' }
    const sp = site.manifest.spine.coords
    // walk the spine, which is what driving does: a straight line off the road would leave the
    // planting radius and stop being a fair test of the near set.
    const walk = []
    let acc = 0
    for (let i = 1; i < sp.length; i++) {
      const [ax, ay] = sp[i - 1]
      const [bx, by] = sp[i]
      const seg = Math.hypot(bx - ax, by - ay)
      for (let d = 0; d < seg; d += 5) {
        acc += 5
        if (acc < STEP_M) continue
        acc = 0
        const u = d / seg
        walk.push([ax + (bx - ax) * u, ay + (by - ay) * u, (bx - ax) / seg, (by - ay) / seg])
      }
      if (walk.length >= STEPS) break
    }
    const samples = []
    let worst = { doubled: -1 }
    for (const [px, py, dx, dy] of walk) {
      const eye = new THREE.Vector3(px, (site.groundAt(px, -py) ?? 0) + 2, -py)
      const fwd = new THREE.Vector3(dx, 0, -dy).normalize()
      site.updateNear(eye, 0, fwd, 0)
      // DRAW between steps, because an upload happens when the renderer next draws the mesh — not
      // every frame and not on a timer. Without this nothing is ever uploaded and `sent` lags
      // `marked` for a reason that is not the bug.
      window.corridor.drawFrame?.()
      const c = site.treeCards()
      samples.push(c)
      if (c.doubled > worst.doubled) worst = { ...c, at: [Math.round(px), Math.round(py)] }
    }
    const replants = samples.length ? samples[samples.length - 1].replants : 0
    return {
      slug: site.manifest.slug,
      steps: samples.length,
      replants,
      nearSetMax: Math.max(...samples.map((s) => s.nearSet)),
      cardsMax: Math.max(...samples.map((s) => s.cards)),
      inBandMax: Math.max(...samples.map((s) => s.inBand)),
      band: samples.length ? samples[samples.length - 1].band : 0,
      doubledMax: worst.doubled,
      doubledTotalStepsAffected: samples.filter((s) => s.doubled > 0).length,
      // what reached the GPU, against what was written
      uploads: samples.length ? samples[samples.length - 1].uploads : null,
      worst,
    }
  },
  { STEPS, STEP_M },
)
console.log(JSON.stringify(out, null, 1))
await browser.close()

// Fail loudly, and refuse to pass on a run that could not have caught the bug.
const fail = (m) => {
  console.error(`FAIL: ${m}`)
  process.exitCode = 1
}
if (out.error) fail(out.error)
else if (!(out.replants >= 2)) fail(`only ${out.replants} replants — the bug needs one, so this run proves nothing`)
else if (!(out.nearSetMax > 50)) fail(`near set never exceeded ${out.nearSetMax} trees — nothing was measured`)
// Liveness: with a dissolve band configured, SOME near-set tree must be showing a card, or the
// accessor is reading a buffer nothing writes and a clean result means nothing. With the band
// switched off there is legitimately never one, and `doubled` is then simply every visible card.
else if (out.band > 0 && !(out.inBandMax > 0)) fail(`no near-set tree ever showed a dissolving card across a ${out.band} m band — the accessor is reading the wrong buffer`)
else if (out.doubledMax > 0) fail(`${out.doubledMax} impostor cards drawn inside near-field models (${out.doubledTotalStepsAffected}/${out.steps} steps affected)`)
// THE HALF THE MATRICES CANNOT SHOW. Every count above reads the CPU array, which stays right
// while the screen is wrong; these two say whether what was written actually reached the GPU.
else if (!out.uploads) fail('the impostor upload state was not reported — nothing checked whether the writes were sent')
else if (!(out.uploads.matrixMarked > 0)) fail('no instance matrix was ever written — this run measured nothing')
else if (out.uploads.matrixSent < out.uploads.matrixMarked) {
  fail(`${out.uploads.matrixMarked - out.uploads.matrixSent} of ${out.uploads.matrixMarked} matrix writes never reached the GPU — a card is hidden in memory and standing on the screen`)
} else if (out.uploads.fadeSent < out.uploads.fadeMarked) {
  fail(`${out.uploads.fadeMarked - out.uploads.fadeSent} of ${out.uploads.fadeMarked} fade writes never reached the GPU`)
} else console.log(`PASS: no card over a near-field model, and all ${out.uploads.matrixMarked} matrix writes reached the GPU`)
