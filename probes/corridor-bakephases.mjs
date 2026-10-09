// What the three bake-side precomputes of PERF-RIG.md ("For the bake") cost the frame, measured
// under the test rig on this box — the CPU half, because the agent box has no GPU.
//
//   node probes/corridor-bakephases.mjs <site> --phase cpu   [--port 5193] [--secs 40] [--speed 78]
//   node probes/corridor-bakephases.mjs <site> --phase ktx2  [--port 5193] [--secs 40] [--speed 78]
//   node probes/corridor-bakephases.mjs <site> --phase cpu --prove     # the negatives
//
// `cpu` is the tree replant (nearPerf.treesPlant, the replant's own parts, and how many records
// the replant WALKED against how many it holds) and the grass generator (grass.perf.genMs, and the
// share of it spent on the per-cell eligibility questions). The renderer is stubbed for it:
// swiftshader takes 300–1000 ms a frame on this box and the frame loop would run at 2 Hz, which
// is no rig run at all; with `renderer.render` a no-op the loop runs at ~58 Hz and the rig holds
// 78 m/s. Nothing the replant or the grass generator does depends on the render.
//
// `ktx2` keeps the renderer (lite, 320x200, Low) and reads `framePerf.render` on every frame
// against the pyramid's photo arrivals, then — because swiftshader's render cost is nothing like
// a card's — times the one operation the format changes in isolation: `renderer.initTexture`
// (decode done, upload + mipmaps) on a jpg texture and on its ktx2 twin, N tiles each, from the
// page's own loaders. `compressed` (how many resident photos came back as ktx2) is the check.
//
// THE CONTROL IS THE POINT (feedback: probes must fail loudly). `--prove` runs each phase's check
// against a run that must fail it: the old whole-disc replant (TREE_PATCH 0, on a small radius so
// it stays affordable), on which no block walk ever happens; and for ktx2, the jpg-only site, on
// which no resident photo is compressed. A check that cannot fail is not a check. (The first cut
// of the negative was TREE_REPLANT_M at a billion metres — and 77 replants still happened, because
// every arriving branch cell asks for one whatever the distance; that is a finding, not a control.)
//
// The rig is started six seconds after boot and restarted if drive mode drops: the level's late
// physics/traffic arrival throws the first car away (main.ts, "Throw it away; the next Tab …"),
// which is what made the first runs of this probe sit at s = 2685 for ninety seconds.
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const site = args.find((a) => !a.startsWith('--')) ?? 'crofton-triangle'
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const PORT = opt('--port', process.env.CORRIDOR_PORT ?? '5193')
const PHASE = opt('--phase', 'cpu')
const SECS = +opt('--secs', '40')
const WARM = +opt('--warm', '10')
const SPEED = +opt('--speed', '78')
const PROVE = args.includes('--prove')
const LITE = PHASE === 'ktx2' || PHASE === 'orient' || args.includes('--lite')

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
// `cpu` runs at a desktop width: LITE is also `innerWidth < 900`, and a lite site plants 25k trees
// where a full one plants 120k — the replant walk is proportional. `ktx2` stays small for swiftshader.
const page = await browser.newPage({ viewport: PHASE === 'cpu' ? { width: 960, height: 600 } : { width: 320, height: 200 } })
const RUN_SECS = PHASE === 'orient' ? 2 : SECS
const RUN_WARM = PHASE === 'orient' ? 0 : WARM
const errors = []
page.on('pageerror', (e) => { errors.push(e.message); console.log('pageerror', e.message) })
// Low detail (no shadows, no probes) and the knobs the run needs, through the stores the app
// reads at boot. `tune.set` persists nothing, so a load-time knob has to go in before the page.
const knobs = PROVE && PHASE === 'cpu' ? { TREE_PATCH: 0, TREE_PLANT_RADIUS_M: 300, TREE_SPARE_M: 0 } : {}
await page.addInitScript((knobs) => {
  try {
    localStorage.setItem('apex-corridor.settings.v1', JSON.stringify({ detail: 'low' }))
    localStorage.setItem('apex-corridor-visuals.tune.v1', JSON.stringify({ v: 2, values: knobs, touched: Object.keys(knobs) }))
  } catch {}
}, knobs)
const t0 = Date.now()
await page.goto(`http://127.0.0.1:${PORT}/?${LITE ? 'lite' : ''}#${site}`, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.corridor?.site && !!window.__apex, null, { timeout: 900000 })
if (errors.length) throw new Error(`page errors during boot: ${errors.join(' | ')}`)
console.log(`booted ${site} in ${((Date.now() - t0) / 1000).toFixed(1)} s (${LITE ? 'lite' : 'full'}, Low)`)
await page.waitForTimeout(6000)

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0 }
const stat = (a) => ({ n: a.length, p50: +q(a, 0.5).toFixed(2), p90: +q(a, 0.9).toFixed(2), p99: +q(a, 0.99).toFixed(2), max: +(a.length ? Math.max(...a) : 0).toFixed(2) })

const info = await page.evaluate(() => {
  const s = window.corridor.site
  const P = s.manifest.layers.pyramid
  return { pyramid: P ? { zmin: P.zmin, zmax: P.zmax, tiles: P.list.length, texture: P.texture, ktx2: P.texture_ktx2 ?? null, graded: !!P.graded, grass: P.grass ?? null } : null, trees: s.treePlanting().count }
})
console.log('site', JSON.stringify(info))

if (PHASE === 'cpu') {
  await page.evaluate(() => { window.__apex.renderer.render = () => {} })
}
// the per-frame sampler: what every frame cost by section, plus the counters that change rarely
await page.evaluate(() => {
  const rows = []
  window.__rows = rows
  let last = performance.now()
  const tick = () => {
    const now = performance.now()
    const fp = window.__apex.framePerf
    const np = window.corridor.site.nearPerf
    const g = window.corridor.site.grass
    const tp = window.corridor.site.treePlanting()
    const py = window.corridor.site.pyramid?.()
    rows.push({ dt: now - last, render: fp.render, world: fp.world, physics: fp.physics, treesPlant: np.treesPlant, treesPump: np.treesPump, treesPatch: np.treesPatch, grass: np.grass, pyr: np.pyr, genMs: g?.perf?.genMs ?? 0, replants: tp.replants, lastMs: tp.lastMs, parts: tp.parts, walked: tp.walked, movedMs: tp.movedMs, blocks: tp.blocks, count: tp.count, records: tp.records, pyrLoads: py?.loads ?? 0, photos: py?.photos ?? 0, askMs: g?.perf?.questionsMs ?? 0, askN: g?.perf?.cellsAsked ?? 0, askRej: g?.perf?.cellsRejected ?? 0, genTotalMs: g?.perf?.genTotalMs ?? 0 })
    last = now
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})
const startRig = () => page.evaluate((speed) => window.corridor.rig.start({ speed, fireEvery: 0 }), SPEED)
console.log('rig started', await startRig())
const keepDriving = setInterval(async () => {
  try {
    const on = await page.evaluate(() => window.__apex.drive.on)
    if (!on) { console.log('drive mode dropped — restarting the rig'); await startRig() }
  } catch {}
}, 1000)
await page.waitForTimeout(RUN_WARM * 1000)
await page.evaluate(() => { window.__rows.length = 0 })
await page.waitForTimeout(RUN_SECS * 1000)
clearInterval(keepDriving)
const out = await page.evaluate(() => { const r = window.__rows; const st = window.corridor.rig.stats(); window.corridor.rig.stop(); return { rows: r, rig: st, trees: window.corridor.site.treePlanting(), pyr: window.corridor.site.pyramid?.() } })
const rows = out.rows
// the sampler lives on the page: no rows means the page RELOADED under the run (a source file
// saved while it ran — Vite reloads every attached tab), and nothing below would be a measurement
if (!rows) { console.log('FAIL the page reloaded during the run (Vite HMR?) — no samples'); await browser.close(); process.exit(1) }
console.log('rig', JSON.stringify({ seconds: out.rig.seconds, distance: out.rig.distance, speed: out.rig.speed, resets: out.rig.resets }), 'frames', rows.length, 'dt', JSON.stringify(stat(rows.map((r) => r.dt))))
const col = (k) => rows.map((r) => r[k])
let failed = false
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed = true }

if (PHASE === 'cpu') {
  for (const k of ['world', 'treesPlant', 'treesPump', 'treesPatch', 'grass', 'genMs']) console.log(k.padEnd(11), JSON.stringify(stat(col(k))))
  // every replant: the row where the counter moved carries that replant's parts
  const replants = []
  let prev = rows[0]?.replants ?? 0
  for (const r of rows) if (r.replants !== prev) { replants.push(r); prev = r.replants }
  for (const r of replants) console.log(`replant #${r.replants} ${r.lastMs} ms`, JSON.stringify({ plant: +r.parts.plant.toFixed(2), grid: +r.parts.grid.toFixed(2), near: +r.parts.near.toFixed(2), far: +r.parts.far.toFixed(2), reseat: +r.parts.reseat.toFixed(2) }), `walked ${r.walked ?? '?'} of ${r.records ?? '?'} records in ${r.movedMs ?? '?'} ms (${r.count} live${r.blocks != null ? `, ${r.blocks} blocks` : ''})`)
  const plants = replants.map((r) => r.parts.plant)
  console.log('replant plant part', JSON.stringify(stat(plants)), 'walked/records', JSON.stringify(stat(replants.map((r) => (r.records ? (r.walked ?? r.records) / r.records : 1)))))
  // the grass questions' share of the generator
  const g0 = rows[0], g1 = rows[rows.length - 1]
  if (g0 && g1) {
    const ask = g1.askMs - g0.askMs, gen = g1.genTotalMs - g0.genTotalMs, n = g1.askN - g0.askN, rej = g1.askRej - g0.askRej
    console.log(`grass questions: ${ask.toFixed(1)} ms of ${gen.toFixed(1)} ms generated (${gen ? ((100 * ask) / gen).toFixed(0) : '?'}%), ${n} cells asked, ${rej} rejected (${n ? ((100 * rej) / n).toFixed(0) : '?'}%), ${n ? ((1000 * ask) / n).toFixed(1) : '?'} µs a cell`)
  }
  check('the rig drove', out.rig.distance > SPEED * SECS * 0.5, `${out.rig.distance} m in ${SECS} s`)
  check('replants happened', replants.length >= 2, `${replants.length} replants`)
  check('a replant walks its blocks, and fewer records than it holds', replants.some((r) => r.walked > 0 && r.records && r.walked < r.records * 0.8), replants.length ? `walked/records p50 ${q(replants.map((r) => (r.records ? (r.walked ?? r.records) / r.records : 1)), 0.5).toFixed(2)}, walked max ${Math.max(...replants.map((r) => r.walked ?? 0))}` : 'no replant')
}

if (PHASE === 'ktx2' || PHASE === 'orient') {
  for (const k of ['render', 'world', 'pyr']) console.log(k.padEnd(11), JSON.stringify(stat(col(k))))
  // the frames on which a photo landed, against the rest
  const landed = [], rest = []
  for (let i = 1; i < rows.length; i++) (rows[i].photos > rows[i - 1].photos ? landed : rest).push(rows[i].render)
  console.log('render on a photo-arrival frame', JSON.stringify(stat(landed)), 'other frames', JSON.stringify(stat(rest)))
  console.log('pyramid', JSON.stringify(out.pyr))
  // the operation itself, in isolation: upload + mipmaps of a decoded tile, jpg against ktx2
  const iso = await page.evaluate(async (n) => {
    const s = window.corridor.site
    const P = s.manifest.layers.pyramid
    const base = `/sites/${s.manifest.slug}/web/${P.dir}/`
    const r = window.__apex.renderer
    const THREE = window.__apex.THREE
    const leaves = P.list.filter((e) => e.z === P.zmax && e.naip && !e.empty).slice(0, n)
    const time = async (make) => {
      const out = []
      for (const e of leaves) {
        const tex = await make(e)
        const t0 = performance.now()
        r.initTexture(tex)
        out.push(performance.now() - t0)
        tex.dispose()
      }
      return out
    }
    const jpg = await time((e) => new Promise((ok, no) => { const t = new THREE.TextureLoader().load(`${base}${e.z}/${e.x}_${e.y}.jpg`, () => { t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; ok(t) }, undefined, no) }))
    let ktx = null
    if (P.texture_ktx2 && window.__apex.ktx2Loader) {
      const l = window.__apex.ktx2Loader()
      ktx = await time((e) => new Promise((ok, no) => l.load(`${base}${e.z}/${e.x}_${e.y}.${P.texture_ktx2}`, ok, undefined, no)))
    }
    // THE SAME WAY UP? three uploads the jpg with flipY and cannot flip a compressed texture, so
    // the twin has to be stored bottom-up by the bake. Draw each on a quad into a render target
    // through three's own upload paths — exactly what the terrain does with them — and compare
    // the row-luma profiles: same orientation correlates high; a mirrored twin correlates with
    // the jpg's profile REVERSED instead. (The transcoded level is not readable: swiftshader
    // takes BPTC, so reading `mipmaps[0]` back as RGBA is not an option here.)
    let orient = null
    if (P.texture_ktx2 && window.__apex.ktx2Loader && leaves.length) {
      const e = leaves[0]
      const l = window.__apex.ktx2Loader()
      const kt = await new Promise((ok, no) => l.load(`${base}${e.z}/${e.x}_${e.y}.${P.texture_ktx2}`, ok, undefined, no))
      const jt = await new Promise((ok, no) => { const t = new THREE.TextureLoader().load(`${base}${e.z}/${e.x}_${e.y}.jpg`, () => ok(t), undefined, no) })
      for (const t of [kt, jt]) t.colorSpace = THREE.SRGBColorSpace
      const N = 64
      const rt = new THREE.WebGLRenderTarget(N, N)
      const scene = new THREE.Scene()
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2)
      cam.position.z = 1
      const mat = new THREE.MeshBasicMaterial()
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat))
      const rows = (tex) => {
        mat.map = tex
        mat.needsUpdate = true
        const prev = r.getRenderTarget()
        r.setRenderTarget(rt)
        r.render(scene, cam)
        const px = new Uint8Array(N * N * 4)
        r.readRenderTargetPixels(rt, 0, 0, N, N, px)
        r.setRenderTarget(prev)
        const out = []
        for (let y = 0; y < N; y++) { let sum = 0; for (let x = 0; x < N; x++) { const i = (y * N + x) * 4; sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] } out.push(sum / N) }
        return out
      }
      const corr = (a, b) => { const n = Math.min(a.length, b.length); let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i] } ma /= n; mb /= n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2 } return sab / Math.sqrt(saa * sbb || 1) }
      const kr = rows(kt), jr = rows(jt)
      orient = { tile: `${e.z}/${e.x}_${e.y}`, same: +corr(kr, jr).toFixed(3), flipped: +corr(kr, [...jr].reverse()).toFixed(3), flipY: kt.flipY, jpgFlipY: jt.flipY, format: kt.format, rowsK: kr.slice(0, 4).map((v) => +v.toFixed(0)), rowsJ: jr.slice(0, 4).map((v) => +v.toFixed(0)) }
      rt.dispose()
      kt.dispose()
      jt.dispose()
    }
    return { jpg, ktx, n: leaves.length, orient }
  }, +opt('--n', '12'))
  console.log(`initTexture (upload + mips), ${iso.n} leaf tiles: jpg`, JSON.stringify(stat(iso.jpg)), 'ktx2', iso.ktx ? JSON.stringify(stat(iso.ktx)) : 'n/a (no twin on this bake)')
  console.log('orientation', JSON.stringify(iso.orient))
  if (iso.orient && iso.orient.same != null) check('the ktx2 is the same way up as the jpg', iso.orient.same > 0.9 && iso.orient.same > iso.orient.flipped + 0.2, `row-profile correlation same ${iso.orient.same}, flipped ${iso.orient.flipped}`)
  // swiftshader renders at 1–2 Hz with the scene on: the rig only has to have MOVED, so photos land on a drive
  if (PHASE === 'ktx2') check('the rig drove', out.rig.distance > 100, `${out.rig.distance} m in ${SECS} s`)
  if (PHASE === 'ktx2') check('photos landed during the run', (out.pyr?.photos ?? 0) > 0, `${out.pyr?.photos} photos`)
  check('the resident photos are ktx2', (out.pyr?.compressedHeld ?? 0) > 0 && (out.pyr?.compressedHeld ?? 0) === (out.pyr?.photosHeld ?? -1), `${out.pyr?.compressedHeld} of ${out.pyr?.photosHeld} resident photos compressed`)
}

await browser.close()
if (PROVE) {
  // the negatives: a `--prove` run passes only when the checks FAILED
  console.log(failed ? 'PROVE OK: the checks fail when the mechanism is off' : 'PROVE FAILED: the checks passed with the mechanism off')
  process.exit(failed ? 0 : 1)
}
process.exit(failed ? 1 : 0)
