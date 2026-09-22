// What the grass costs the CPU while driving, measured without the renderer in the way.
//
//   PORT=5201 SLUG=bowie-racetrack-rd SPEED=30 SECONDS=8 node probes/corridor-grasscpu.mjs
//
// WHY THIS EXISTS. corridor-grassperf.mjs measures real frame time, which is the number that
// matters — but this dev box has no GPU (no /dev/dri, no nvidia), so Chromium falls back to
// swiftshader, and at Rich's density (275 k blades × 11 triangles, DoubleSide) it renders about
// ONE frame in ten seconds. Eight seconds of driving produced zero sampled frames. Frame time
// here would measure swiftshader, not the grass.
//
// So this probe stops the app's render loop and drives `grass.update()` itself along the spine at
// SPEED, one call per simulated 1/60 s. That is exactly the work the grass does per frame on the
// CPU — tile generation, the LOD walk, buffer assembly — and it is GPU-independent. It also
// reports the queue depth (`pending`), which is what "the ring shows bare tiles ahead" means, and
// the triangle count handed to the GPU, which is what Rich's card will actually have to draw.
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'bowie-racetrack-rd'
const SPEED = Number(process.env.SPEED ?? 30)
const SECONDS = Number(process.env.SECONDS ?? 8)
const HZ = Number(process.env.HZ ?? 60)
const MS = process.env.MS ? Number(process.env.MS) : null // override GRASS_MS_PER_FRAME

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
// the app picks its site from location.hash; a new bake reorders index.json, so assert it
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug && !!window.corridor.site.grass, SLUG, { timeout: 300000 })

const result = await page.evaluate(async ({ speed, seconds, hz, ms }) => {
  if (ms != null) window.corridor.tune.set('GRASS_MS_PER_FRAME', ms)
  const THREEup = { x: 0, y: 1, z: 0 }
  const site = window.corridor.site
  const grass = site.grass
  // stop the app's own loop: frame() re-arms itself through rAF, so a no-op rAF ends it after the
  // frame in flight. Nothing else touches grass.update after that, so the eye path below is ours.
  const realRaf = window.requestAnimationFrame
  window.requestAnimationFrame = () => 0
  await new Promise((r) => realRaf(() => realRaf(r)))

  const camera = window.corridor.camera
  const eye = camera.position.clone()
  const fwd = camera.getWorldDirection(new (eye.constructor)())
  const step = speed / hz
  const frames = Math.round(seconds * hz)
  const s0 = site.manifest.spine.photo_s
  const sMax = site.manifest.spine.length_m

  // warm start: put the eye on the road and let the cold fill drain, so the run measures a car
  // already moving through country the cache has not seen, not the first-load burst.
  const place = (s) => {
    const p = site.spineAt(Math.min(sMax - 1, s))
    eye.set(p.pos.x, p.pos.y + 1.5, p.pos.z)
    fwd.set(p.dir.x, 0, p.dir.z).normalize()
    return p
  }
  place(s0)
  let guard = 0
  do { grass.update(eye, fwd, 0) } while (grass.counts.pending > 0 && ++guard < 4000)
  const coldFillFrames = guard

  const gen = [], asm = [], tot = [], pend = [], blades = [], cards = [], tris = [], nearEmpty = [], nearUp = [], pendEmpty = []
  for (let i = 0; i < frames; i++) {
    place(s0 + i * step)
    const t0 = performance.now()
    grass.update(eye, fwd, 0)
    const dt = performance.now() - t0
    const p = grass.perf, c = grass.counts
    tot.push(dt)
    gen.push(p.genMs)
    asm.push(p.asmMs)
    pend.push(c.pending)
    nearEmpty.push(p.nearestEmpty)
    nearUp.push(p.nearestUpgrade)
    pendEmpty.push(p.pendingEmpty)
    blades.push(c.blades)
    cards.push(c.cards)
    tris.push(p.triangles)
  }
  window.requestAnimationFrame = realRaf
  void THREEup

  const r1 = (v) => Math.round(v * 100) / 100
  const stats = (a) => {
    const s = [...a].sort((x, y) => x - y)
    const at = (p) => r1(s[Math.min(s.length - 1, Math.floor(s.length * p))])
    return { median: at(0.5), p90: at(0.9), p99: at(0.99), max: r1(s[s.length - 1]), mean: r1(a.reduce((t, v) => t + v, 0) / a.length) }
  }
  const max = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity)
  return {
    site: site.manifest.slug,
    speed_ms: speed,
    simulated_hz: hz,
    frames,
    cold_fill_update_calls: coldFillFrames,
    update_ms: stats(tot),
    generate_ms: stats(gen),
    assemble_ms: stats(asm),
    pending: { max: max(pend), mean: r1(pend.reduce((t, v) => t + v, 0) / pend.length), frames_nonzero: pend.filter((v) => v > 0).length },
    // the acceptance test: the world is complete inside `nearestMissing`, so bare ground is only
    // visible if that ever drops inside the blade ring (GRASS_RADIUS, 106 m by default)
    // a hole the eye could see = an EMPTY tile inside the card ring; an upgrade is only a tile
    // that already has cards waiting for its blades, which never reads as bare ground
    nearest_empty_m: { min: Math.round(Math.min(...nearEmpty.filter(Number.isFinite))), frames_inside_blade_ring: nearEmpty.filter((v) => v < 106).length },
    nearest_upgrade_m: { min: Math.round(Math.min(...nearUp.filter(Number.isFinite))) },
    pending_empty: { max: max(pendEmpty), mean: r1(pendEmpty.reduce((t, v) => t + v, 0) / pendEmpty.length) },
    blades_mean: Math.round(blades.reduce((t, v) => t + v, 0) / blades.length),
    cards_mean: Math.round(cards.reduce((t, v) => t + v, 0) / cards.length),
    triangles_mean: Math.round(tris.reduce((t, v) => t + v, 0) / tris.length),
    tiles_cached: grass.counts.tiles,
    ms_per_frame: window.corridor.tune.get('GRASS_MS_PER_FRAME'),
    grass_radius: window.corridor.tune.get('GRASS_RADIUS'),
  }
}, { speed: SPEED, seconds: SECONDS, hz: HZ, ms: MS })

console.log(JSON.stringify(result))
await browser.close()
