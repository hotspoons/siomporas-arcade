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
await page.goto(`http://localhost:${PORT}/?lite=1#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
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
await page.waitForTimeout(2000)

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

/** stand at a site point, look down, render, and report how many fragments of the built world survive */
const litAt = async (p, fade) =>
  page.evaluate(
    ({ p, fade }) =>
      new Promise((resolve) => {
        const c = window.corridor
        c.tune.set('SPLAT_WORLD_FADE', fade)
        const g = c.site.groundAt(p.x, p.z) ?? 0
        c.camera.position.set(p.x, g + 26, p.z)
        c.orbit.target.set(p.x, g, p.z)
        c.orbit.update()
        let n = 0
        const tick = () => {
          if (++n < 8) return requestAnimationFrame(tick)
          const r = c.renderer
          r.render(c.scene, c.camera)
          const gl = r.getContext()
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
          const buf = new Uint8Array(w * h * 4)
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
          // the built world is everything that is not the clear colour; count what is drawn
          let drawn = 0
          for (let i = 0; i < w * h; i++) {
            const o = i * 4
            if (buf[o] + buf[o + 1] + buf[o + 2] > 24) drawn++
          }
          resolve({ drawn, px: w * h })
        }
        requestAnimationFrame(tick)
      }),
    { p, fade },
  )

const res = {}
if (info.inside) { res.insideOff = await litAt(info.inside, 0); res.insideOn = await litAt(info.inside, 1) }
if (info.outside) { res.outsideOff = await litAt(info.outside, 0); res.outsideOn = await litAt(info.outside, 1) }
console.log(JSON.stringify({ ...info, res }, null, 1))
await browser.close()

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
const keep = (a) => (a ? a.drawn / a.px : 0)
if (!info.inside) fail('found no point inside a capture envelope — the seam raster covers nothing')
else if (!info.outside) fail('found no point clear of every capture — cannot tell yielding from disappearing')
else if (!(info.cov.covered > 0)) fail('the seam raster is empty')
// liveness: the built world must actually be drawing at these points, or nothing is being measured
else if (!(keep(res.insideOff) > 0.5)) fail(`with the seam off, only ${(100 * keep(res.insideOff)).toFixed(0)}% of the frame is built world — nothing was measured`)
// 1. inside the envelope the bake must yield
else if (!(keep(res.insideOn) < keep(res.insideOff) * 0.35)) fail(`inside a capture the built world still covers ${(100 * keep(res.insideOn)).toFixed(0)}% of the frame against ${(100 * keep(res.insideOff)).toFixed(0)}% with the seam off — it is not yielding`)
// 2. and outside it, it must not
else if (!(keep(res.outsideOn) > keep(res.outsideOff) * 0.95)) fail(`away from every capture the built world lost fragments (${(100 * keep(res.outsideOn)).toFixed(0)}% against ${(100 * keep(res.outsideOff)).toFixed(0)}%) — the seam is leaking outside the envelope`)
else console.log(`PASS: seam ${info.cov.w}x${info.cov.h} at ${info.cov.cellM} m from ${info.cov.segments} pass segments. Inside a capture the built world goes ${(100 * keep(res.insideOff)).toFixed(0)}% -> ${(100 * keep(res.insideOn)).toFixed(0)}% of the frame; away from one it holds at ${(100 * keep(res.outsideOn)).toFixed(0)}%.`)
