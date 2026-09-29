// The asset library: a place to work on what worlds are made of.
//
// Rich, 2026-09-28: "I don't understand why we have asset place buttons where, it is really
// confusing... No reason to have the map visible, no reason to have place buttons - this should
// really just be the catalog and materials and service form taking up the whole area in tabs plus
// a new tab to manage static props like barns, stores, etc. in the exact same way we manage cars
// from the catalog. We maybe need tabs for each class", plus importing models, a shared-versus-
// world-specific concept, and the rig editor.
//
// A PROPS TAB IS A CLASS FILTER, not a second screen. "Exactly the same way we manage cars" is
// only true if it IS the same screen, so this checks that the class tabs filter one list rather
// than that a second list exists.
//
//   node probes/corridor-assetlib.mjs [world-slug]
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const SVC = process.env.ASSETSVC ?? 'http://localhost:8790'
const WORLD = process.argv[2] ?? 'arrowhead-farms-network'
const TEMP = 'zzprobe-import'

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)
const items = () => fetch(`${SVC}/catalog`).then((r) => r.json()).then((j) => j.items)

for (const id of [TEMP, `${TEMP}-${WORLD}`]) await fetch(`${SVC}/catalog/${id}`, { method: 'DELETE' }).catch(() => {})
await fetch(`${SVC}/catalog`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: TEMP, subject: 'a probe crate', kind: 'prop' }),
})

await page.goto(`http://localhost:${PORT}/world.html?world=${WORLD}#${WORLD}`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForSelector('.seg', { timeout: 30000 })
await page.click('.seg[data-value="assets"]')
await page.waitForSelector('#assets .asset-row', { timeout: 30000 })
// WAIT FOR THE STATE, not for a guess at how long it takes. On a loaded machine the mode switch
// and the first render land well after any fixed delay, and a probe that checks too early reports
// "the map is still behind it" about a page that is simply not finished.
await page.waitForFunction(() => {
  const map = document.getElementById('map')
  return map && getComputedStyle(map).display === 'none' && document.querySelectorAll('#assets .class-tab').length > 1
}, null, { timeout: 30000 })

/* ---- 1 · it is the whole area, not a dialog over a map ---- */
const shape = await page.evaluate(() => ({
  pane: !document.getElementById('assets')?.hidden,
  map: getComputedStyle(document.getElementById('map')).display,
  inspector: getComputedStyle(document.querySelector('.inspector')).display,
  dialogs: document.querySelectorAll('.dialog').length,
  tabs: [...document.querySelectorAll('#assets [role="tab"], #assets .tab')].map((n) => n.textContent.trim()),
}))
say('the area', shape)
if (!shape.pane) fail.push('the assets pane is not showing')
if (shape.dialogs) fail.push('it is still a dialog')
if (shape.inspector !== 'none') fail.push('the world inspector is still beside it')
if (shape.map !== 'none') fail.push('the map is still behind it')
for (const t of ['Catalog', 'Materials', 'Service']) if (!shape.tabs.includes(t)) fail.push(`no ${t} tab`)

const placeButtons = await page.locator('#assets button', { hasText: /^Place$/ }).count()
say('place buttons', placeButtons)
if (placeButtons) fail.push('the library still offers to place things')

/* ---- 1b · the toolbar is the Catalog tab's, not the pane's ---- */
// Rich, 2026-09-29: "New items should be under the assets tab set and specific to the catalog
// tab". Above the tab set it read as a pane-wide action while doing nothing on Materials or
// Service. Asserted by POSITION, not by existence: a button that merely exists somewhere in
// `#assets` would pass this whether it moved or not.
const toolbar = await page.evaluate(() => {
  const b = [...document.querySelectorAll('#assets button')].find((x) => /New item/.test(x.textContent))
  if (!b) return { found: false }
  const panel = b.closest('.tab-panel')
  return {
    found: true,
    inACatalogPanel: !!panel && !!panel.querySelector('.asset-split'),
    aboveTheTabs: !!b.closest('#assets > .asset-pane-bar, .asset-pane > .asset-pane-bar'),
  }
})
say('New item lives', toolbar)
if (!toolbar.found) fail.push('there is no way to make a new item at all')
else {
  if (!toolbar.inACatalogPanel) fail.push('New item is not inside the Catalog tab')
  if (toolbar.aboveTheTabs) fail.push('New item still sits above the tab set')
}
// and the list is still bounded: a toolbar added to the panel without a row for it would let the
// columns size to their content, which is how this pane grew to six thousand pixels before
const bounded = await page.evaluate(() => {
  const l = document.querySelector('#assets .asset-list')
  return l ? { scrolls: l.scrollHeight > l.clientHeight + 4, h: Math.round(l.clientHeight) } : null
})
say('the list still scrolls', bounded)
// 950px viewport: a list taller than that is not scrolling, it is pushing the page
if (!bounded || bounded.h < 80 || bounded.h > 950) fail.push(`the asset list is ${bounded?.h}px tall — the height chain is broken`)

/* ---- 2 · one tab per class, filtering one list ---- */
const classes = await page.locator('#assets .class-tab').allTextContents()
say('class tabs', classes.slice(0, 6))
if (classes.length < 2) fail.push('no class tabs')
const all = await page.locator('#assets .asset-row').count()
await page.locator('#assets .class-tab', { hasText: 'prop' }).first().click()
await page.waitForFunction((n) => document.querySelectorAll('#assets .asset-row').length !== n, all, { timeout: 10000 }).catch(() => {})
const props = await page.locator('#assets .asset-row').count()
say('all vs prop', { all, props })
if (props >= all) fail.push('choosing a class did not narrow the list')
if (!props) fail.push('the prop class shows nothing')
await page.locator('#assets .class-tab', { hasText: 'all' }).first().click()
await page.waitForTimeout(400)

/* ---- 3 · shared versus this world ---- */
const scope = await page.locator('#assets .segmented button').allTextContents()
say('scope', scope)
if (!scope.includes(WORLD)) fail.push(`no way to see only ${WORLD}`)

await page.locator('#assets .tree-filter input').fill(TEMP)
await page.waitForTimeout(500)
await page.locator('#assets .asset-row').first().click()
await page.waitForTimeout(700)
say('chips on it', await page.locator('#assets .asset-detail-head .chip').allTextContents())

const forkBtn = page.locator('#assets button', { hasText: `Customise for ${WORLD}` })
if (!(await forkBtn.count())) fail.push('a shared asset offers no way to make this world its own copy')
else {
  await forkBtn.click()
  await page.waitForTimeout(600)
  await page.locator('.dialog button', { hasText: 'Make a copy' }).click()
  await page.waitForTimeout(2000)
  const after = await items()
  const copy = after.find((x) => x.id === `${TEMP}-${WORLD}`)
  const original = after.find((x) => x.id === TEMP)
  say('forked', copy && { id: copy.id, world: copy.world, from: copy.forkedFrom })
  if (!copy) fail.push('the copy was not made')
  else if (copy.world !== WORLD) fail.push(`the copy belongs to ${copy.world}, not ${WORLD}`)
  // the whole point: the shared one is untouched
  if (original?.world != null) fail.push('forking changed the shared original')
}

/* ---- 4 · importing a model ---- */
await page.locator('#assets .tree-filter input').fill(TEMP)
await page.waitForTimeout(500)
await page.locator('#assets .asset-row').first().click()
await page.waitForTimeout(600)
const chooser = page.waitForEvent('filechooser')
await page.locator('#assets button', { hasText: 'Import a model' }).click()
const fc = await chooser
// four bytes of glTF magic: the service checks exactly that, and a real model is megabytes
await fc.setFiles({ name: 'probe.glb', mimeType: 'model/gltf-binary', buffer: Buffer.concat([Buffer.from('glTF'), Buffer.alloc(28)]) })
await page.waitForTimeout(2500)
const imported = await fetch(`${SVC}/catalog/${TEMP}`).then((r) => r.json())
say('after import', { mesh: imported.mesh, state: imported.state })
if (!imported.mesh) fail.push('the imported model did not become the item’s mesh')

/* ---- 5 · the rig binding survives a round trip ---- */
await fetch(`${SVC}/catalog`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: TEMP, rig: { roles: { wheel: ['wheel_fl', 'wheel_fr'], steer: ['steering'] } } }),
})
const rigged = await fetch(`${SVC}/catalog/${TEMP}`).then((r) => r.json())
say('rig kept', rigged.rig?.roles)
if (rigged.rig?.roles?.wheel?.length !== 2) fail.push('a saved rig binding is not kept on the asset')
// and it survives an unrelated edit, which is what "stored with the asset" has to mean
await fetch(`${SVC}/catalog`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: TEMP, subject: 'edited elsewhere' }),
})
const still = await fetch(`${SVC}/catalog/${TEMP}`).then((r) => r.json())
if (still.rig?.roles?.wheel?.length !== 2) fail.push('editing something else wiped the rig')

for (const id of [TEMP, `${TEMP}-${WORLD}`]) await fetch(`${SVC}/catalog/${id}`, { method: 'DELETE' }).catch(() => {})
if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: the library is the whole area, filters by class, forks per world, imports models and keeps a rig')
await browser.close()
process.exit(fail.length ? 1 : 0)
