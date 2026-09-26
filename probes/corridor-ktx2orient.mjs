// Is a tile's KTX2 imagery drawn the same way up as its JPEG twin?
//
// three's KTX2Loader hands back a CompressedTexture with flipY = false (a compressed upload cannot
// be flipped), while every other texture in the viewer is a plain Texture with flipY = true, and
// the terrain UVs were written against the latter. If the two differ the streamed tiles are
// mirrored north-south under the roads, which would look exactly like "the imagery is offset".
//
// Measured, not argued: load the site at a stance inside the imagery ring, wait for a tile's own
// texture, then decode BOTH the ktx2 (through the page's own loader, transcoded to RGBA where the
// GPU has no compressed format, which is what swiftshader does) and the jpg, and compare the mean
// luma of their top and bottom rows. Same orientation -> top matches top.
//
//   PORT=5185 node probes/corridor-ktx2orient.mjs '<stance url>'
import { chromium } from 'playwright'
const [, , url] = process.argv
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction(() => !!window.corridor?.site, null, { timeout: 300000 })
// let the stream bring a tile in
await page.waitForFunction(() => (window.corridor.site.tiles?.()?.resident ?? 0) > 0, null, { timeout: 120000 }).catch(() => null)
console.log(await page.evaluate(async () => {
  const site = window.corridor.site
  const counts = site.tiles?.()
  const st = site.tileStream
  const [key, tex] = [...(st?.loaded ?? new Map()).entries()][0] ?? []
  if (!key) return JSON.stringify({ counts, note: 'no tile texture resident' })
  const out = { key, counts, isCompressed: !!tex.isCompressedTexture, flipY: tex.flipY, format: tex.format, mips: tex.mipmaps?.length, repeatY: tex.repeat?.y, offsetY: tex.offset?.y }
  // the ktx2's level-0 rows, if the transcode left us readable RGBA
  const m0 = tex.mipmaps?.[0]
  if (m0 && m0.data && tex.format === 1023) {
    const w = m0.width, h = m0.height, d = m0.data
    const row = (r) => { let s = 0; for (let x = 0; x < w; x++) { const i = (r * w + x) * 4; s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] } return s / w }
    out.ktx2 = { w, h, top: +row(0).toFixed(1), bottom: +row(h - 1).toFixed(1), q1: +row(Math.floor(h / 4)).toFixed(1), q3: +row(Math.floor((3 * h) / 4)).toFixed(1) }
  } else {
    out.ktx2 = { note: 'level 0 is a compressed block format; rows not readable here', format: tex.format }
  }
  // the jpg twin
  const img = new Image()
  img.crossOrigin = 'anonymous'
  const base = `/sites/${site.manifest.slug}/web/${site.manifest.layers.tiles.dir}/${key}.naip.jpg`
  await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = base })
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, c.width, c.height).data
  const jrow = (r) => { let s = 0; for (let x = 0; x < c.width; x++) { const i = (r * c.width + x) * 4; s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] } return s / c.width }
  out.jpg = { w: c.width, h: c.height, top: +jrow(0).toFixed(1), bottom: +jrow(c.height - 1).toFixed(1), q1: +jrow(Math.floor(c.height / 4)).toFixed(1), q3: +jrow(Math.floor((3 * c.height) / 4)).toFixed(1) }
  return JSON.stringify(out)
}))
await browser.close()
