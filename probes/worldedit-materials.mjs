// The materials browser, and the one number that matters in it.
//
// The other half of the assetlib fold: a prop is a mesh, a material is three maps and
// `metres_per_tile`. That number is the game — it turns a photograph of bricks into a wall of the
// right size — and it is the field a generated texture reliably gets wrong.
//
// So the check is not "an image appeared". It is that the tile size is HONOURED: the sample wall
// is a fixed eight metres, so a 2 m material must show four courses across it and a 0.5 m one
// sixteen. Rendering the same picture at the same scale whatever the number says is exactly the
// failure this browser exists to catch, and it looks perfectly fine.
//
//   PORT=5185 node probes/worldedit-materials.mjs
import { chromium } from 'playwright'
const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message.slice(0, 160)); console.log('pageerror', e.message.slice(0, 200)) })
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__we?.ready?.() === true, null, { timeout: 90000 })

const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

await page.evaluate(() => {
  const b = [...document.querySelectorAll('header.topbar button')]
    .find((n) => /generate an asset/i.test(n.getAttribute('title') ?? ''))
  b?.click()
})
await page.waitForFunction(() => !!document.querySelector('.dialog'), null, { timeout: 30000 })
await page.evaluate(() => {
  const t = [...document.querySelectorAll('.dialog .tab, .dialog [role="tab"], .dialog button')]
    .find((n) => /materials/i.test(n.textContent ?? ''))
  t?.click()
})
await page.waitForFunction(() => !!document.querySelector('.material-row'), null, { timeout: 30000 }).catch(() => {})

const rows = await page.evaluate(() => document.querySelectorAll('.material-row').length)
ok('the materials browser lists the library', rows > 5, `${rows} materials`)
ok('grouped by what they are, not by id',
  await page.evaluate(() => document.querySelectorAll('.material-list .group').length > 1),
  `${await page.evaluate(() => document.querySelectorAll('.material-list .group').length)} categories`)

await page.waitForTimeout(3500)
ok('the sample wall is drawn',
  await page.evaluate(() => { const c = window.__meshview.capture(); return c.max - c.min > 25 }),
  JSON.stringify(await page.evaluate(() => window.__meshview.capture())))

/*
 * metres_per_tile IS HONOURED.
 *
 * Read off the material actually in the scene rather than from the manifest: the question is what
 * the renderer did, and `repeat` is the only place the answer lives. A fixed 8 m wall means
 * repeat = 8 / metres_per_tile, so a 2 m brick repeats 4x and a 0.5 m one 16x.
 */
const tiles = await page.evaluate(() => {
  const out = []
  const rows = [...document.querySelectorAll('.material-row')]
  return new Promise((resolve) => {
    let i = 0
    const step = () => {
      if (i >= Math.min(rows.length, 4)) return resolve(out)
      rows[i].click()
      i += 1
      setTimeout(() => {
        const cap = document.querySelector('.material-caption')?.textContent ?? ''
        const m = /([\d.]+) m tile/.exec(cap)
        // reach into the scene for what the texture was actually told to do
        const v = window.__meshview
        let repeat = null
        v.root.dataset.probe = '1'
        const scene = v
        // the wall is the only mesh in the pivot
        const walls = []
        ;(function walk(o) { if (o.isMesh) walls.push(o); (o.children ?? []).forEach(walk) })(scene.pivot ?? {})
        const wall = walls[0]
        if (wall?.material?.map) repeat = wall.material.map.repeat.x
        out.push({ caption: cap.slice(0, 40), declared: m ? Number(m[1]) : null, repeat })
        step()
      }, 1200)
    }
    step()
  })
})
const checked = tiles.filter((t) => t.declared && t.repeat != null)
ok('the tile size reaches the texture', checked.length >= 2, `${checked.length} materials measured`)
for (const t of checked) {
  const want = 8 / t.declared
  ok(`${t.declared} m tile repeats ${want.toFixed(1)}x across the 8 m wall`,
    Math.abs(t.repeat - want) < 0.01, `repeat ${t.repeat?.toFixed(2)}`)
}
// and two different tile sizes really do differ — a browser that ignored the number would show
// the same repeat for everything and every line above would still pass
const distinct = new Set(checked.map((t) => t.repeat)).size
ok('CONTROL: different materials get different repeats', checked.length < 2 || distinct > 1,
  `${distinct} distinct repeats across ${checked.length}`)

ok('nothing threw', errors.length === 0, errors[0] ?? 'clean')
await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: the materials read at the right size')
process.exit(fails.length ? 1 : 0)
