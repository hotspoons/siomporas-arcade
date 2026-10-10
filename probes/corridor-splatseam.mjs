// Does the built world get out of the way where the capture takes over?
//
// Rich, 2026-09-27: "let's get my neighborhood baked into the world properly with a crossfade of
// corridor rendered world as you approach the edge of the splats."
//
// The seam is a coverage raster in site metres: 0 where the bake owns the ground, 1 where the
// capture does, with the capture's own fade band between. Every material in the built world
// samples it and discards a screen-door pattern of fragments — a dissolve rather than a blend,
// because gaussians are depth-sorted against the scene and a half-transparent road cannot take
// part in that order.
//
// THIS DOES NOT LOAD ANY GAUSSIANS. The envelope comes from `corridor.json`, which is where the
// camera was, not from the tiles — so the seam can be measured without pulling 1.5 GB of PLY
// through a software rasteriser. What it measures is the thing that would otherwise be invisible
// until a tile happened to be resident: that the bake yields, that it yields in the right place,
// and that it does not yield anywhere else.
//
//   PORT=5185 node probes/corridor-splatseam.mjs [slug]
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'arrowhead-farms-network'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 560, height: 380 } })
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 200)))
page.on('console', (m) => { if (/^splats:/.test(m.text())) console.log('  page:', m.text()) })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://localhost:${PORT}/#${slug}?lite=1`, { waitUntil: 'domcontentloaded', timeout: 120000 })
/*
 * STOP THE STREAM BEFORE IT STARTS.
 *
 * The seam comes from `corridor.json` -- where the camera was -- and not from the tiles, so it
 * can be measured without a single gaussian. Letting the tiles load instead pulls 52 MB PLYs into
 * a software rasteriser and kills the tab, which is what happened the first two times this ran.
 * The knob table is published before the captures attach, so this lands in the gap: the envelope
 * is still built, the raster is still drawn, and `update` never loads anything.
 */
await page.waitForFunction(() => !!window.corridor?.tune, null, { timeout: 600000 })
await page.evaluate(() => window.corridor.tune.set('SPLAT_ENABLED', 0))
await page.waitForFunction(() => !!window.corridor?.site && !!window.corridor.splatCover?.(), null, { timeout: 600000 })
/*
 * PUT THE SUN UP FIRST.
 *
 * The world clock homes to the real time, and the first run of this measured a site at night: the
 * ground was there, 818,644 triangles of it, and not one pixel passed a brightness threshold, so
 * the control point read as "nothing is drawn here" and the whole comparison was against black.
 * Solar noon is `12 - lon/15` in UTC, which lands within an hour anywhere, and the elevation is
 * read back rather than assumed.
 */
await page.evaluate(async () => {
  const c = window.corridor
  const lon = c.site.manifest.frame?.anchor?.lon ?? 0
  const noon = (12 - lon / 15 + 24) % 24
  const fmt = (h) => `${String(((Math.round(h) % 24) + 24) % 24).padStart(2, '0')}:00`
  let h = noon
  let el = -99
  for (let k = 0; k < 4; k++) {
    c.time.setLocal('2026-09-26', fmt(h))
    await new Promise((r) => requestAnimationFrame(r))
    const e = c.time.sun().el
    if (e < el) { c.time.setLocal('2026-09-26', fmt(h - 1)); break }
    el = e
    h += 1
  }
})
await page.waitForTimeout(2000)
const sunEl = await page.evaluate(() => +window.corridor.time.sun().el.toFixed(1))
console.log('  sun elevation for the measurement:', sunEl, 'degrees')

const info = await page.evaluate(() => {
  const c = window.corridor
  const cov = c.splatCover?.() ?? null
  const fields = c.splats?.() ?? []
  if (!cov || !fields.length) return { error: 'no capture attached to this site', fields }
  // a point ON a capture pass, and one far from every pass — found from the envelope itself
  const site = c.site
  const bb = site.manifest.bbox
  let inside = null
  let outside = null
  for (let k = 0; k < 4000 && (!inside || !outside); k++) {
    const x = bb[0] + Math.random() * (bb[2] - bb[0])
    const y = bb[1] + Math.random() * (bb[3] - bb[1])
    // read the SEAM, not `weightAt`: the stream is off, so weightAt reports 0 everywhere. The
    // raster is what the shaders actually sample, which is the honest thing to test against.
    const w = c.splatSeamAt(x, -y)
    if (w > 0.99 && !inside) inside = { x, z: -y, w }
    if (w === 0 && !outside) {
      // and not merely just outside: somewhere the bake unambiguously owns
      let near = false
      for (let r = 40; r <= 120 && !near; r += 40) for (const a of [0, 1.57, 3.14, 4.71]) if (c.splatSeamAt(x + r * Math.cos(a), -(y + r * Math.sin(a))) > 0) near = true
      if (!near) outside = { x, z: -y, w }
    }
  }
  return { cov, fields, inside, outside }
})
if (info.error) { console.log(JSON.stringify(info, null, 1)); await browser.close(); console.error(`FAIL: ${info.error}`); process.exit(1) }

/**
 * Stand at a site point, LET THE WORLD FINISH BUILDING, then take a frame at each seam strength.
 *
 * The build is lazy and eye-driven, so the first frame after a camera move is a half-built world
 * and differencing it against a later one measures the build pump. The settle loop below waits
 * for the drawn-pixel count to stop changing before anything is compared — and the seam is moved
 * through `splatFade`, which writes the uniform and does NOT retune, because a retune re-seeds
 * the grass and re-picks the trees and the difference image would then be of the vegetation.
 */
const settleAt = async (p) =>
  page.evaluate(
    ({ p }) =>
      new Promise((resolve) => {
        const c = window.corridor
        const g = c.site.groundAt(p.x, p.z) ?? 0
        c.camera.position.set(p.x, g + 26, p.z)
        c.orbit.target.set(p.x, g, p.z)
        c.orbit.update()
        let last = -1
        let stable = 0
        let n = 0
        const tick = () => {
          n++
          const r = c.renderer
          c.drawFrame()
          const tris = r.info.render.triangles
          if (Math.abs(tris - last) < Math.max(200, last * 0.002)) stable++
          else stable = 0
          last = tris
          if (stable >= 12 || n > 600) return resolve({ frames: n, triangles: tris })
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    { p },
  )

/**
 * Take a frame at each seam strength and DIFF THEM IN THE PAGE.
 *
 * Counting "lit" pixels against a brightness threshold cannot work: at night the ground is below
 * any threshold that excludes the background, and in daylight the sky is above it, so the same
 * test read 0% and then 100% of the same scene. What the seam does is CHANGE pixels, and that
 * needs no absolute threshold at all — it is its own control.
 *
 * Both frames stay in the page; shipping two 850 kB buffers over the debugging protocol per point
 * is slower than the measurement.
 */
const seamDiff = async (to) =>
  page.evaluate(
    ({ to }) =>
      new Promise((resolve) => {
        const c = window.corridor
        /*
         * THE TRIANGLE COUNT TRAVELS WITH THE PIXELS.
         *
         * This difference attributes every changed pixel to the seam, and the world is STILL
         * BUILDING underneath it: tiles arrive asynchronously, the settle loop can go quiet while
         * one is in flight, and the geometry that lands between the two grabs is counted as the
         * seam leaking. That is what a 4.4% "leak" at a point whose mask reads 0, with nothing
         * within 120 m of it, turned out to be — 1.8 M triangles where a settled world there has
         * over 4 M. A difference taken across a changing world is not a measurement of anything,
         * so the comparison now knows whether it was.
         */
        const grab = () => {
          const r = c.renderer
          c.drawFrame()
          const gl = r.getContext()
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
          const buf = new Uint8Array(w * h * 4)
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
          return { w, h, buf, tris: r.info.render.triangles }
        }
        const settle = (n, then) => {
          let k = 0
          const t = () => (++k < n ? requestAnimationFrame(t) : then())
          requestAnimationFrame(t)
        }
        c.splatFade(0)
        settle(6, () => {
          const a = grab()
          c.splatFade(to)
          settle(6, () => {
            const b = grab()
            let changed = 0
            let darker = 0
            for (let i = 0; i < a.w * a.h; i++) {
              const o = i * 4
              const d = Math.abs(a.buf[o] - b.buf[o]) + Math.abs(a.buf[o + 1] - b.buf[o + 1]) + Math.abs(a.buf[o + 2] - b.buf[o + 2])
              if (d > 24) {
                changed++
                if (b.buf[o] + b.buf[o + 1] + b.buf[o + 2] < a.buf[o] + a.buf[o + 1] + a.buf[o + 2]) darker++
              }
            }
            c.splatFade(null)
            resolve({
              px: a.w * a.h,
              changed,
              darker,
              changedPct: +((100 * changed) / (a.w * a.h)).toFixed(1),
              tris: [a.tris, b.tris],
              // the world must be the SAME world in both frames, or the difference is of the world
              steady: Math.abs(a.tris - b.tris) <= Math.max(500, a.tris * 0.002),
            })
          })
        })
      }),
    { to },
  )

const res = {}
if (info.inside) {
  res.insideSettle = await settleAt(info.inside)
  // a crossfade, not a switch: half the strength must remove less than all of it
  res.insideHalf = await seamDiff(0.5)
  res.inside = await seamDiff(1)
}
if (info.outside) { res.outsideSettle = await settleAt(info.outside); res.outside = await seamDiff(1) }
console.log(JSON.stringify({ ...info, sunEl, res }, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
const IN = res.inside
const OUT = res.outside
if (!(sunEl > 10)) fail(`the sun is at ${sunEl} degrees — too dark to see what a dissolve removed`)
else if (!info.inside) fail('found no point inside a capture envelope — the seam raster covers nothing')
else if (!info.outside) fail('found no point clear of every capture — cannot tell yielding from disappearing')
else if (!(info.cov.covered > 0)) fail('the seam raster is empty')
// liveness: both points must have a settled, built world under them, or the diff is of the build
else if (!(res.insideSettle?.triangles > 100000)) fail(`only ${res.insideSettle?.triangles} triangles at the inside point — the world has not built there`)
else if (!(res.outsideSettle?.triangles > 100000)) fail(`only ${res.outsideSettle?.triangles} triangles at the outside point — the world has not built there`)
// 1. inside a capture the bake must yield, and yield by going AWAY (darker), not by changing colour
else if (!(IN.changedPct > 10)) fail(`inside a capture the seam changed only ${IN.changedPct}% of the frame — the built world is not yielding`)
// a FADE and not a switch, which is what Rich asked for: half the strength must remove
// noticeably less. (Removed fragments reveal whatever is behind them — often the sky, which is
// brighter than shaded ground — so "did it get darker" is not the test it looks like.)
else if (!(res.insideHalf.changed < IN.changed * 0.85)) fail(`half strength changed ${res.insideHalf.changedPct}% against ${IN.changedPct}% at full — the seam is a switch, not a crossfade`)
// 2. and away from every capture it must not move at all
else if (!OUT.steady) fail(`the world was still building at the outside point (${OUT.tris[0]} then ${OUT.tris[1]} triangles) — this difference is of the world, not of the seam`)
else if (!IN.steady) fail(`the world was still building at the inside point (${IN.tris[0]} then ${IN.tris[1]} triangles) — this difference is of the world, not of the seam`)
else if (!(OUT.changedPct < 1)) fail(`away from every capture the seam changed ${OUT.changedPct}% of the frame — it is leaking outside the envelope`)
else console.log(`PASS: seam ${info.cov.w}x${info.cov.h} at ${info.cov.cellM} m from ${info.cov.segments} pass segments, sun ${sunEl}deg. Inside a capture it dissolves ${IN.changedPct}% of the frame at full strength and ${res.insideHalf.changedPct}% at half; away from one it changes ${OUT.changedPct}%.`)
