// Crop fields: are there rows, are they aligned, and does the season move them?
//
//   PORT=5201 SLUG=chesterfield-rd node probes/corridor-crops.mjs
//
// Rich's ask (main's 009) is a FIELD — rows running in one direction with furrows between them —
// so the things to check are the row count per crop, that the rows follow the authored or
// inferred heading, and that a season change moves the standing height without a rebuild.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'chesterfield-rd'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 300000 })

console.log(JSON.stringify(await page.evaluate(() => {
  const site = window.corridor.site, tune = window.corridor.tune
  const g = site.layers.crops
  const farmland = (site.manifest.landuse ?? []).filter((l) => l.class === 'farmland').length
  if (!g) return { site: site.manifest.slug, farmland_rings: farmland, crops: null, note: 'no crop group built' }
  const meshes = g.children.map((m) => ({
    crop: m.userData.crop,
    triangles: m.geometry.index.count / 3,
    vertices: m.geometry.getAttribute('position').count,
  }))
  // the season is four uniforms: read the standing height back for each season without a rebuild
  const heights = {}
  for (const s of ['winter', 'spring', 'summer', 'autumn']) {
    site.setSeason(s)
    heights[s] = Object.fromEntries(g.children.map((m) => [m.userData.crop, +m.material.uniforms.uHeight.value.toFixed(2)]))
  }
  site.setSeason('summer')
  // row direction: take the first two vertices of a ribbon and compare with the field heading
  const first = g.children[0]
  const p = first.geometry.getAttribute('position')
  const rowDeg = (Math.atan2(p.getX(1) - p.getX(0), -(p.getZ(1) - p.getZ(0))) * 180) / Math.PI
  return {
    site: site.manifest.slug,
    farmland_rings: farmland,
    rows_by_crop: site.cropRows,
    meshes,
    first_row_bearing_deg: +((rowDeg + 360) % 180).toFixed(1),
    standing_height_m_by_season: heights,
    row_scale_knob: tune.get('CROP_ROW_SCALE'),
  }
})))
await browser.close()
