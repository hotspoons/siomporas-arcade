// Holes in the world: ground you can see the sky through.
//
//   PORT=5201 SLUG=braddock-i70 node probes/corridor-holes.mjs
//
// Casts straight down over a grid across the corridor and asks whether ANY ground surface — the
// corridor strip, the coarse terrain, or the road itself — is hit. A miss is a hole. They appear
// where two surfaces each assume the other is covering a patch: sinkUnderStrip drops the terrain
// triangles the strip covers, so anything that makes the strip not actually be there at ground
// level (a bridge deck ten metres up, a station skipped for a branch, a width limit) punches one.
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5201'
const SLUG = process.env.SLUG ?? 'braddock-i70'
const STEP = Number(process.env.STEP ?? 5)
const HALF = Number(process.env.HALF ?? 46)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('pageerror', e.message))
await page.route('**/@vite/client', (r) => r.abort())
await page.goto(`http://127.0.0.1:${PORT}/#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForFunction((slug) => window.corridor?.site?.manifest?.slug === slug, SLUG, { timeout: 300000 })

if (process.env.S_FROM) await page.evaluate(([a, b]) => { window.__sFrom = a; window.__sTo = b }, [Number(process.env.S_FROM), Number(process.env.S_TO)])
console.log(JSON.stringify(await page.evaluate(({ step, half }) => {
  const site = window.corridor.site, mod = window.corridor.THREE
  const ground = []
  site.group.traverse((o) => { if (o.isMesh && (o.name === 'strip' || o.name === 'terrain')) ground.push(o) })
  site.layers.road?.traverse((o) => { if (o.isMesh) ground.push(o) })
  const ray = new mod.Raycaster(new mod.Vector3(), new mod.Vector3(0, -1, 0), 0, 9000)
  const decks = site.manifest.structures.filter((s) => s.kind === 'bridge').map((s) => [s.s_start, s.s_end])
  const onDeck = (s) => decks.some(([a, b]) => s >= a - 25 && s <= b + 25)
  let n = 0, holes = 0, holesNearDecks = 0, holesElsewhere = 0
  const worst = []
  const sFrom = window.__sFrom ?? 10, sTo = window.__sTo ?? site.manifest.spine.length_m - 10
  for (let s = sFrom; s < sTo; s += step) {
    const st = site.spineAt(s)
    const side = new mod.Vector3(-st.dir.z, 0, st.dir.x).normalize()
    for (let o = -half; o <= half; o += step) {
      const x = st.pos.x + side.x * o, z = st.pos.z + side.z * o
      ray.set(new mod.Vector3(x, 4000, z), new mod.Vector3(0, -1, 0))
      n++
      if (ray.intersectObjects(ground, false).length === 0) {
        holes++
        if (onDeck(s)) holesNearDecks++
        else { holesElsewhere++; if (worst.length < 12) worst.push([Math.round(s), o]) }
      }
    }
  }
  return {
    site: site.manifest.slug, samples: n, step, half,
    holes, holes_pct: +(100 * holes / n).toFixed(2),
    holes_within_25m_of_a_deck: holesNearDecks,
    holes_elsewhere: holesElsewhere,
    elsewhere_examples_s_offset: worst,
    decks,
  }
}, { step: STEP, half: HALF })))
await browser.close()
