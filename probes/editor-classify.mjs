// Why did a tagged building not become one? Runs the classifier in-page over every footprint and
// reports the ones whose tags name a category, with what happened to each.
import { chromium } from 'playwright'
const slug = process.argv[2] ?? 'frederick-i70'
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const p = await b.newPage({ viewport: { width: 900, height: 600 } })
await p.route('**/@vite/client', (r) => r.abort())
p.on('pageerror', (e) => console.log('pageerror', e.message))
await p.goto(`http://localhost:5207/editor.html#${slug}:grow`, { waitUntil: 'load' })
await p.waitForFunction(() => document.querySelector('#status')?.textContent === '' && !!window.corridor?.site, null, { timeout: 300000 })
const out = await p.evaluate(async () => {
  const ag = await import('/src/editor/autogen.ts')
  const { site, place, grow } = window.corridor
  const m = site.manifest
  const ctx = ag.contextOf(m, site)
  const rows = []
  const tally = {}
  m.buildings.forEach((bl, i) => {
    const zone = ag.zoneOf(bl, ctx)
    const cat = ag.categoryOf(bl, zone, ctx.poiFor.get(i) ?? null)
    tally[cat] = (tally[cat] ?? 0) + 1
    const fit = ag.fitAsset(bl, cat, place.assets, grow.params)
    const named = bl.tags?.name
    const interesting = ['school', 'church', 'hotel', 'gas_station', 'big_box', 'warehouse', 'restaurant', 'barn', 'utility', 'apartments'].includes(cat)
    if (interesting) {
      rows.push(`${String(i).padStart(3)} ${cat.padEnd(12)} A=${String(Math.round(bl.area_m2)).padStart(5)} H=${String(bl.height_m).padStart(5)} lat=${String(Math.round(bl.lat)).padStart(4)} zone=${zone.padEnd(11)} -> ${fit ? `${fit.entry.id} x${fit.scale}` : 'NO FIT'}  ${named ?? ''}`)
    }
  })
  return { rows, tally, n: m.buildings.length }
})
console.log(`${out.n} footprints; classified:`, JSON.stringify(out.tally))
console.log(out.rows.join('\n'))
await b.close()
