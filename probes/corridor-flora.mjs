// What this site decided grows on it, and what it would have decided before.
//
//   PORT=5201 SLUG=acadia-ocean-dr node probes/corridor-flora.mjs
//   PORT=5201 SLUG=all            node probes/corridor-flora.mjs     # every site with a flora block
//
// Species and ground cover are the two things in this world you cannot check by looking at a
// screenshot: a spruce-shaped tree is only right if the data says spruce, and "the hillside looks
// browner" is not a measurement. So this prints numbers on both sides of the change:
//
//   BEFORE  the rule this replaced — canopy height and a hash over five fixed hardwood presets —
//           replayed over the SAME measured trees (site.treeSpecies(true))
//   AFTER   the draw from the LANDFIRE class the tree stands on and the FIA species mix in it
//
// plus the vegetation classes with their corridor area share, the ground-cover class, and — for
// each of the four seasons — how far this site's palette has moved from the piedmont reference and
// what that does to the grass. Colours are printed as hex because a hillside going from #97a054 to
// #cfbd8a IS the answer to "is California brown in September".
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5201'
const WANT = process.env.SLUG ?? 'acadia-ocean-dr'

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())

const index = await (await fetch(`http://127.0.0.1:${PORT}/sites/index.json`)).json()
const slugs = WANT === 'all' ? index.sites.map((s) => s.slug) : WANT.split(',')

for (const slug of slugs) {
  await page.goto(`http://127.0.0.1:${PORT}/#${slug}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForFunction((s) => window.corridor?.site?.manifest?.slug === s && !!window.corridor.site.treePalette, slug, { timeout: 300000 })
  const out = await page.evaluate(() => {
    const site = window.corridor.site
    const f = site.flora
    const seasons = ['winter', 'spring', 'summer', 'autumn']
    const before = site.treeSpecies(true)
    const after = site.treeSpecies(false)
    const pal = site.treePalette()
    const evergreen = new Set(pal.filter((p) => p.evergreen).map((p) => p.id))
    const total = Object.values(after).reduce((a, b) => a + b, 0) || 1
    const conifer = Object.entries(after).reduce((a, [k, v]) => a + (evergreen.has(k) ? v : 0), 0)
    // the season palettes this site actually gets, through setSeason
    const looks = {}
    for (const s of seasons) {
      site.setSeason(s)
      const a = site.grass.applied
      looks[s] = { dry: +a.dry.toFixed(2), base: a.base, tip: a.tip, type: a.type, blades: a.blades }
    }
    site.setSeason('summer')
    return {
      slug: site.manifest.slug,
      trees: total,
      source: f ? f.block.evt.source : 'NONE (no flora in this bake)',
      cover: site.cover,
      classes: f ? f.classes.slice(0, 6).map((c) => ({ pct: +(100 * c.share).toFixed(1), name: c.name, lf: c.lifeform, sub: c.subclass, ground: c.ground, from: c.species_from ?? null, spp: (c.species ?? []).slice(0, 3).map((s) => `${f.block.canopy.ref[s.key]?.common ?? s.key} ${(100 * s.weight).toFixed(0)}%`) })) : [],
      canopy: f ? { coverage: +(100 * f.block.canopy.coverage).toFixed(0), rasters: `${f.block.canopy.rasters_with_data}/${f.block.canopy.rasters_here}`, species: f.block.canopy.species.slice(0, 8).map((s) => { const r = f.block.canopy.ref[s.key]; return `${r?.common ?? s.key} ${(100 * s.weight).toFixed(0)}%${r?.canopy_h_m ? ` @${r.canopy_h_m}m` : ''}` }) } : null,
      ground: f ? f.block.ground.classes.slice(0, 6).map((g) => `${g.key} ${(100 * g.weight).toFixed(0)}%`) : [],
      climate: f ? { annual_mm: f.block.climate.annual_mm, summer_dry_pct: +(100 * f.block.climate.summer_dry).toFixed(1), curing: Object.fromEntries(seasons.map((s) => [s, +f.curing({ winter: 1, spring: 3, summer: 8, autumn: 10 }[s]).toFixed(2)])) } : null,
      palette: pal.map((p) => `${p.id} (${p.leaf}${p.evergreen ? ', evergreen' : ''})`),
      before,
      after,
      conifer_pct: +(100 * conifer / total).toFixed(1),
      looks,
    }
  })

  const pct = (h) => { const t = Object.values(h).reduce((a, b) => a + b, 0) || 1; return Object.entries(h).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${(100 * v / t).toFixed(0)}%`).join(', ') }
  console.log(`\n=== ${out.slug}  ${out.trees.toLocaleString()} measured trees`)
  console.log(`    source   ${out.source}`)
  for (const c of out.classes) console.log(`    ${String(c.pct).padStart(5)}%  ${c.name.slice(0, 50).padEnd(50)} ${c.lf.padEnd(6)} ${c.ground.padEnd(24)} ${c.from ?? '-'}  ${c.spp.join(', ')}`)
  if (out.canopy) console.log(`    canopy   ${out.canopy.coverage}% of tree pixels carry basal area (${out.canopy.rasters} rasters): ${out.canopy.species.join(', ')}`)
  console.log(`    ground   ${out.ground.join(', ')}`)
  console.log(`    cover    verge=${out.cover.open} (grass ${out.cover.grass}), floor=${out.cover.floor}, from ${out.cover.source}`)
  if (out.climate) console.log(`    climate  ${out.climate.annual_mm} mm/yr, Jun-Aug ${out.climate.summer_dry_pct}% of it; curing ${JSON.stringify(out.climate.curing)}`)
  console.log(`    built    ${out.palette.join(' | ')}`)
  console.log(`    BEFORE   ${pct(out.before)}`)
  console.log(`    AFTER    ${pct(out.after)}   -> ${out.conifer_pct}% evergreen`)
  for (const [s, l] of Object.entries(out.looks)) console.log(`    ${s.padEnd(8)} grass ${l.type}x${l.blades} dry ${String(l.dry).padEnd(5)} base ${l.base} tip ${l.tip}`)
}
await browser.close()
