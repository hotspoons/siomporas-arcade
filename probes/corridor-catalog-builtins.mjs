// The Catalog lists everything the place editor can place — the built-ins included.
//
// Rich, 2026-10-10: "Catalog was supposed to show props like horse bridges and water towers, these
// show up in the place editor but don't show up in the catalog." The place editor reads a MERGE
// (catalogmerge.ts: the placeable list plus the library's meshed props) and the Catalog tab listed
// only the library. So the assertion here is the merge itself, asked in the page the same way the
// place editor asks it, against the rows the Catalog renders: every id the place editor can place
// must be a row. Then the two Rich named, by the words he used, through the search box — and the
// detail of one, which must say where it comes from and show its model.
//
//   PORT=5196 WORLD=crofton-triangle SHOTS=/tmp/shots node probes/corridor-catalog-builtins.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const WORLD = process.env.WORLD ?? 'crofton-triangle'
const SHOTS = process.env.SHOTS ?? ''
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message.slice(0, 200)); console.log('pageerror', e.message.slice(0, 200)) })
const fails = []
const ok = (name, cond, detail) => { console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name} — ${detail}`); if (!cond) fails.push(name) }

await page.goto(`http://127.0.0.1:${PORT}/world.html?world=${WORLD}#${WORLD}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__we?.ready?.() === true, null, { timeout: 90000 })
await page.evaluate(() => window.__we.setMode('assets'))
await page.waitForFunction(() => document.querySelectorAll('#assets .asset-row[data-id]').length > 10, null, { timeout: 60000 })

// what the place editor can place, asked the way it asks (editor/author/catalog.ts → loadCatalog)
const placeable = await page.evaluate(async () => (await import('/src/assets/catalogmerge.ts')).loadMergedCatalog().then((c) => c.assets.map((a) => a.id)))
const rows = await page.evaluate(() => [...document.querySelectorAll('#assets .asset-row[data-id]')].map((r) => r.dataset.id))
const missing = placeable.filter((id) => !rows.includes(id))
ok('the place editor has things to place', placeable.length > 10, `${placeable.length} placeable`)
ok('every one of them is a Catalog row', missing.length === 0, missing.length ? `missing: ${missing.slice(0, 8).join(', ')}` : `${placeable.length} of ${placeable.length} listed among ${rows.length} rows`)

// AND THE CHECK CAN FAIL: the library rows alone — the Catalog as it was — must leave some out
const libraryOnly = await page.evaluate(() => [...document.querySelectorAll('#assets .asset-row[data-id]')].filter((r) => r.querySelector('.asset-src')?.textContent !== 'built-in').map((r) => r.dataset.id))
const wouldMiss = placeable.filter((id) => !libraryOnly.includes(id))
ok('the library rows alone (the old Catalog) miss some — the check can fail', wouldMiss.length > 0, `${wouldMiss.length} missing, e.g. ${wouldMiss.slice(0, 4).join(', ')}`)

const find = async (q) => {
  await page.fill('#assets .asset-list-box .tree-filter input', q)
  await page.waitForTimeout(300)
  return page.evaluate(() => [...document.querySelectorAll('#assets .asset-row[data-id]')].map((r) => ({ id: r.dataset.id, src: r.querySelector('.asset-src')?.textContent })))
}
const tower = await find('water tower')
ok('"water tower" finds the water tower', tower.some((r) => r.id === 'watertower-01'), JSON.stringify(tower))
ok('and says it is built in', tower.find((r) => r.id === 'watertower-01')?.src === 'built-in', String(tower.find((r) => r.id === 'watertower-01')?.src))
const bridge = await find('horse bridge')
ok('"horse bridge" finds the covered horse bridge', bridge.some((r) => r.id === 'horsebridge-01'), JSON.stringify(bridge))

// the detail: the source, the model, and no generation steps it cannot use
await page.click('#assets .asset-row[data-id="horsebridge-01"]')
await page.waitForFunction(() => (window.__meshview?.stats?.triangles ?? 0) > 0, null, { timeout: 60000 }).catch(() => {})
const detail = await page.evaluate(() => ({
  chip: [...document.querySelectorAll('#assets .asset-detail-head .chip')].map((c) => c.textContent),
  tris: window.__meshview?.stats?.triangles ?? 0,
  steps: document.querySelectorAll('#assets .asset-detail .asset-steps').length,
  buttons: [...document.querySelectorAll('#assets .asset-detail button, #assets .asset-detail a.btn')].map((b) => b.textContent.trim()).filter(Boolean),
}))
ok('the detail says built-in', detail.chip.includes('built-in'), detail.chip.join(', '))
ok('and shows the model', detail.tris > 100, `${detail.tris} triangles`)
ok('and offers no draw or mesh step', detail.steps === 0 && !detail.buttons.some((b) => /^(Draw|Mesh)/.test(b)), detail.buttons.join(' | '))
ok('but does offer the copy into the library', detail.buttons.includes('Copy into the library'), detail.buttons.join(' | '))
if (SHOTS) await page.screenshot({ path: `${SHOTS}/catalog-builtin-horsebridge.png` })

// the built-in scope, by itself
await page.fill('#assets .asset-list-box .tree-filter input', '')
await page.evaluate(() => [...document.querySelectorAll('#assets .seg, #assets [role="radio"], #assets button')].find((b) => b.textContent.trim() === 'built-in' && b.closest('.asset-list-box'))?.click())
await page.waitForTimeout(400)
const onlyKit = await page.evaluate(() => [...document.querySelectorAll('#assets .asset-row[data-id]')].map((r) => r.querySelector('.asset-src')?.textContent))
ok('the built-in filter lists only built-ins', onlyKit.length > 5 && onlyKit.every((s) => s === 'built-in'), `${onlyKit.length} rows: ${[...new Set(onlyKit)].join(', ')}`)
if (SHOTS) await page.screenshot({ path: `${SHOTS}/catalog-builtins.png` })

ok('no page errors', errors.length === 0, errors[0] ?? 'none')
await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: the Catalog lists what the place editor places, built-ins included')
process.exit(fails.length ? 1 : 0)
