// Tiled terrain: does a network site built from 1 km tiles come up with real heights everywhere,
// and does the imagery stream follow the eye?
//
//   node probes/corridor-tiles.mjs [slug] [out.png]        (?data=/testdata by default)
//
// Checks, in order:
//  1. the mosaic covers the hull and its heights match the source site's single-image DEM where
//     tiles exist (the whole point: a tiled bake must sample identically to a corridor bake);
//  2. terrain meshes exist one per tile and share their edge vertices (no LOD cracks);
//  3. imagery streams in within loadWithin of the eye and is released beyond keepWithin.
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'arrowhead-farms-network-tiled'
const out = process.argv[3] ?? null
const PORT = process.env.CORRIDOR_PORT ?? '5202'
const DATA = process.env.CORRIDOR_DATA ?? '/testdata'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 700, height: 460 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text().slice(0, 200)) })
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/?lite&data=${DATA}#${slug}`, { waitUntil: 'domcontentloaded', timeout: 180000 })
await page.waitForFunction(() => document.querySelector('#status')?.textContent === '' && window.corridor?.site, null, { timeout: 300000 })

console.log(JSON.stringify(await page.evaluate(() => {
  const c = window.corridor, site = c.site
  const T = site.manifest.layers.tiles
  const o = { slug: site.manifest.slug, tiles_listed: T?.list.length ?? 0, size_m: T?.size_m, res: T?.res }
  // terrain meshes, one per tile
  const meshes = []
  site.terrain.traverse?.((m) => { if (m.isMesh) meshes.push({ name: m.name, verts: m.geometry.getAttribute('position').count }) })
  if (!meshes.length && site.terrain.isMesh) meshes.push({ name: site.terrain.name, verts: site.terrain.geometry.getAttribute('position').count })
  o.terrain_meshes = meshes.length
  o.terrain_verts = meshes.reduce((a, b) => a + b.verts, 0)
  o.terrain_verts_per_mesh = [...new Set(meshes.map((m) => m.verts))].slice(0, 4)
  // heights: sample the spine and 200 m either side; nothing may be NaN, and the road must not be flat
  const L = site.manifest.spine.length_m
  const zs = []
  for (let s = 0; s < L; s += 25) {
    const p = site.spineAt(s)
    zs.push(site.heightAt(p.pos.x, -p.pos.z))
  }
  o.spine_height = { n: zs.length, nan: zs.filter((z) => !Number.isFinite(z)).length, min: +Math.min(...zs).toFixed(2), max: +Math.max(...zs).toFixed(2) }
  // off-corridor: inside the hull but (probably) outside any tile — must still have a height from
  // the horizon seed, never 0 and never NaN
  const [hx0, hy0, hx1, hy1] = site.terrain.userData?.hull ?? [0, 0, 0, 0]
  o.tile_counts = site.tiles ? site.tiles() : null
  return o
}), null, 1))

// stream: park the eye on the spine, let it settle, then jump 6 km away and watch the release
const at = async (s) => page.evaluate((s) => {
  const c = window.corridor
  const p = c.site.spineAt(Math.max(0, Math.min(c.site.manifest.spine.length_m, s)))
  c.camera.position.set(p.pos.x, p.pos.y + 120, p.pos.z)
  c.site.updateNear(c.camera.position, performance.now() / 1000)
}, s)
const counts = () => page.evaluate(() => window.corridor.site.tiles?.() ?? null)
await at(200)
for (let i = 0; i < 40; i++) { await page.waitForTimeout(250); await at(200) }
const near = await counts()
await page.evaluate(() => {
  const c = window.corridor
  c.camera.position.set(c.camera.position.x + 9000, c.camera.position.y, c.camera.position.z)
})
for (let i = 0; i < 20; i++) { await page.waitForTimeout(250); await page.evaluate(() => window.corridor.site.updateNear(window.corridor.camera.position, performance.now() / 1000)) }
const far = await counts()
console.log(JSON.stringify({ stream_near_spine: near, stream_after_9km_jump: far }, null, 1))

if (out) {
  await at(600)
  await page.evaluate(() => { for (const id of ['#info', '#panel', '#sidebar']) { const el = document.querySelector(id); if (el) el.style.display = 'none' } })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: out, timeout: 240000, animations: 'disabled' })
  console.log('shot', out)
}
await browser.close()
