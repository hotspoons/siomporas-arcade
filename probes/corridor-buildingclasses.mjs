// Assets → Buildings: a class's pool is edited, saved per world, and read back by what the game reads.
//
// Rich, 2026-10-10: "a tab in assets to assign textures to classes of buildings … random textures
// feed a single building type … reflectiveness for cases like skyscrapers." So this drives the tab
// as a person would — add a material to the apartments' wall pool, give it a weight, turn the
// tower's reflectiveness up — saves it for the world, and then asks the SAME resolver the game uses
// (facades.ts `resolveFacades`, over the world's surfaces.json and the library's /facades) whether
// it says what was saved. A save that writes a file nothing reads passes every UI check, so the
// check is on the far side. Then it puts the world back as it found it.
//
// WORLD must be a world whose site directory is safe to write (a scratch overlay — see the lane
// rules); the probe restores surfaces.json to what it read.
//
//   PORT=5196 WORLD=crofton-triangle SHOTS=/tmp/shots node probes/corridor-buildingclasses.mjs
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
// what the world had, so it can be put back exactly
const before = await page.evaluate(async (slug) => { const r = await fetch(`/sites/${slug}/surfaces.json`, { cache: 'no-cache' }); return r.ok ? await r.text() : null }, WORLD)
await page.evaluate(() => window.__we.setMode('assets'))
await page.waitForSelector('#assets .tab-strip .tab', { timeout: 30000 })
// the library's first refresh rebuilds every built tab when it lands; let it land before editing,
// or the edit is made in a panel about to be replaced
await page.waitForFunction(() => document.querySelectorAll('#assets .asset-row[data-id]').length > 10, null, { timeout: 60000 })
await page.evaluate(() => [...document.querySelectorAll('#assets .tab-strip .tab')].find((b) => b.textContent.trim() === 'Buildings')?.click())
await page.waitForSelector('#assets .bcl-class', { timeout: 30000 })

const classes = await page.evaluate(() => [...document.querySelectorAll('#assets .bcl-class')].map((g) => ({ id: g.dataset.cls, walls: g.querySelectorAll('[data-pool="walls"] .bcl-entry').length, strip: g.querySelectorAll('[data-pool="walls"] .bcl-seg').length })))
ok('one group per building class', classes.length >= 8, classes.map((c) => c.id).join(', '))
const house = classes.find((c) => c.id === 'house')
ok('the single-family home draws from brick AND siding', !!house && house.walls >= 4, `${house?.walls} wall materials`)
ok('the mix is drawn as a strip, a segment per material', !!house && house.strip === house.walls, `${house?.strip} segments`)
ok('the tab opens on this world, with the shared default one click away', await page.evaluate(() => document.querySelector('#assets .bcl-head .seg.on')?.textContent ?? ''), await page.evaluate(() => [...document.querySelectorAll('#assets .bcl-head .seg')].map((s) => s.textContent).join(' | ')))
if (SHOTS) {
  // the swatches are the library's 1024² albedos: let them arrive before the picture is taken
  await page.waitForFunction(() => [...document.querySelectorAll('#assets .bcl-entry img')].slice(0, 12).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/buildings-tab.png` })
}

// a person's edit: stone ashlar into the apartments' walls at weight 3, the tower more reflective
await page.evaluate(() => {
  const g = document.querySelector('#assets .bcl-class[data-cls="apartments"] [data-pool="walls"] select')
  g.value = 'stone_ashlar'
  g.dispatchEvent(new Event('change'))
})
await page.waitForTimeout(200)
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#assets .bcl-class[data-cls="apartments"] [data-pool="walls"] .bcl-entry')]
  const w = rows[rows.length - 1].querySelector('input')
  w.value = '3'
  w.dispatchEvent(new Event('change'))
})
await page.waitForTimeout(200)
await page.evaluate(() => {
  const r = [...document.querySelectorAll('#assets .bcl-class[data-cls="skyscraper"] input[type="range"]')][0]
  r.value = '0.95'
  r.dispatchEvent(new Event('input'))
})
const pending = await page.evaluate(() => document.querySelector('#assets .lib-foot')?.textContent ?? '')
ok('the edits are pending, not saved', /2 classes changed/.test(pending), pending)
// the library refreshes (Catalog → Refresh rebuilds every tab): an unsaved edit must survive it
const tabClick = (name) => page.evaluate((n) => [...document.querySelectorAll('#assets .tab-strip .tab')].find((b) => b.textContent.trim() === n)?.click(), name)
await tabClick('Catalog')
await page.evaluate(() => [...document.querySelectorAll('#assets .asset-pane-bar button')].find((b) => /Refresh/.test(b.textContent))?.click())
await page.waitForTimeout(2500)
await tabClick('Buildings')
await page.waitForTimeout(500)
const kept = await page.evaluate(() => document.querySelector('#assets .lib-foot')?.textContent ?? '')
ok('and survive the library refreshing under them', /2 classes changed/.test(kept), kept)
await page.evaluate(() => [...document.querySelectorAll('#assets .lib-foot button')].find((b) => /^Save for/.test(b.textContent.trim()))?.click())
await page.waitForFunction(() => /next load/.test(document.querySelector('#assets .lib-foot')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {})

// the far side: what the GAME resolves for this world now
const game = await page.evaluate(async (slug) => {
  const { resolveFacades } = await import('/src/world/facades.ts')
  const doc = await (await fetch(`/sites/${slug}/surfaces.json`, { cache: 'no-cache' })).json()
  const shared = (await (await fetch('/assetsvc/facades', { cache: 'no-cache' })).json()).facades ?? []
  const cls = resolveFacades(shared, doc.buildings)
  const apt = cls.find((c) => c.id === 'apartments')
  const sky = cls.find((c) => c.id === 'skyscraper')
  return { stored: doc.buildings?.classes ?? null, aptWalls: apt.walls, skyMetal: sky.metalness, road: doc.road ?? null }
}, WORLD)
console.log(JSON.stringify(game.stored))
ok('the world file holds the apartments pool with the new material at its weight', game.aptWalls.some((e) => e.material === 'stone_ashlar' && e.weight === 3), JSON.stringify(game.aptWalls))
ok('and keeps the pool it had — an addition, not a replacement', game.aptWalls.length >= 5, `${game.aptWalls.length} entries`)
ok('the tower’s reflectiveness is what the slider said', Math.abs(game.skyMetal - 0.95) < 1e-6, String(game.skyMetal))

// the shared default is untouched by a world save
const shared = await page.evaluate(async () => (await (await fetch('/assetsvc/facades', { cache: 'no-cache' })).json()).facades ?? [])
ok('a world save leaves the shared default alone', !shared.some((r) => r.id === 'apartments' && (r.walls ?? []).some((e) => e.material === 'stone_ashlar')), JSON.stringify(shared.map((r) => r.id)))

// "Use the shared default" drops the world's own for that class
await page.evaluate(() => [...document.querySelectorAll('#assets .bcl-class[data-cls="apartments"] button')].find((b) => /shared default/.test(b.textContent))?.click())
await page.waitForTimeout(200)
await page.evaluate(() => [...document.querySelectorAll('#assets .lib-foot button')].find((b) => /^Save for/.test(b.textContent.trim()))?.click())
await page.waitForTimeout(1500)
const after = await page.evaluate(async (slug) => (await (await fetch(`/sites/${slug}/surfaces.json`, { cache: 'no-cache' })).json()).buildings?.classes ?? {}, WORLD)
ok('"Use the shared default" removes the world’s apartments, keeps its tower', !after.apartments && !!after.skyscraper, JSON.stringify(Object.keys(after)))

// the SHARED default: the other scope, the library's /facades, which every world reads
await page.evaluate(() => [...document.querySelectorAll('#assets .bcl-head .seg')].find((b) => /shared default/.test(b.textContent))?.click())
await page.waitForTimeout(300)
await page.evaluate(() => {
  const r = [...document.querySelectorAll('#assets .bcl-class[data-cls="commercial"] input[type="range"]')][0]
  r.value = '0.3'
  r.dispatchEvent(new Event('input'))
})
await page.evaluate(() => [...document.querySelectorAll('#assets .lib-foot button')].find((b) => /shared default/.test(b.textContent.trim()))?.click())
await page.waitForTimeout(1500)
const sharedNow = await page.evaluate(async () => (await (await fetch('/assetsvc/facades', { cache: 'no-cache' })).json()).facades ?? [])
ok('a shared save writes the library’s record for the class', sharedNow.some((r) => r.id === 'commercial' && Math.abs(r.metalness - 0.3) < 1e-6), JSON.stringify(sharedNow))
await page.evaluate(async () => { await fetch('/assetsvc/facades/commercial', { method: 'DELETE' }) })

// put the world back as it was
await page.evaluate(async ([slug, text]) => {
  await fetch(`/sites/${slug}/surfaces.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text ?? JSON.stringify({ version: 1 }) })
}, [WORLD, before])
ok('no page errors', errors.length === 0, errors[0] ?? 'none')
await browser.close()
console.log(fails.length ? `\nFAIL: ${fails.length} — ${fails.join('; ')}` : '\nPASS: a class pool saved in the Buildings tab is what the game resolves')
process.exit(fails.length ? 1 : 0)
