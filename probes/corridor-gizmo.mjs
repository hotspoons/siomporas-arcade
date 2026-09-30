// The gizmo on a placement whose model this catalog does not have.
//
// Rich, 2026-09-29: *"drag and rotate handles (gizmo) for placed assets don't do anything."* They
// worked on every placement that had a model. `spawn()` returned early when the asset was not in
// the catalog, so those placements had NO OBJECT — nothing drawn, nothing to click, nothing for the
// gizmo to attach to — and nothing said so. The usual cause in development is the frozen placeable
// catalog, so it is not a rare case.
//
// The check is therefore run on a site whose placement names an asset the editor cannot resolve,
// which is the state that used to be invisible.
import { chromium } from 'playwright'

const SLUG = process.env.SLUG ?? 'arrowhead-farms'
const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const p = await b.newPage({ viewport: { width: 1000, height: 700 } })
p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)))
let bad = 0
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++ }

await p.goto(`http://127.0.0.1:5185/editor.html#${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await p.waitForFunction(() => !!window.corridor?.site, null, { timeout: 240000 })
await p.waitForTimeout(8000)
await p.keyboard.press('2') // Place
await p.waitForTimeout(1500)

const out = await p.evaluate(() => {
  const place = window.corridor.place
  const items = place.doc?.items ?? []
  if (!items.length) return { error: 'this site has no placements to select' }
  const missing = place.missingAssets?.() ?? []
  const objects = [...(place.objects?.keys?.() ?? [])]
  const helper = place.group.getObjectByName?.('place-gizmo')
  const before = helper?.visible
  place.select(items[0].id)
  return {
    items: items.length,
    missing: missing.length,
    objects: objects.length,
    beforeSelect: before,
    afterSelect: helper?.visible,
    everyItemHasAnObject: items.every((i) => place.objects.has(i.id)),
  }
})
console.log(JSON.stringify(out))
check(!out.error, out.error ?? 'the site has placements')
if (!out.error) {
  /*
   * EVERY PLACEMENT GETS AN OBJECT, model or no model. A placement with none cannot be selected,
   * moved, turned or deleted — it is in the file and nowhere else.
   */
  check(out.everyItemHasAnObject, `every placement has an object (${out.objects} for ${out.items} items, ${out.missing} of them missing a model)`)
  check(out.beforeSelect === false, 'the gizmo is hidden with nothing selected')
  check(out.afterSelect === true, 'and appears when a placement is selected — including one with no model')
}
console.log(bad ? `FAILED (${bad})` : 'OK')
await b.close()
process.exit(bad ? 1 : 0)
