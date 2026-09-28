// The materials half of the library: one viewer, a prompt you can edit, and nothing overwritten.
//
// Rich, 2026-09-28: "These buttons are confusing, they do kind of the same thing. Why isn't the
// tiled vs up close just an option in the viewer? Also this form sucks, and why we have id and not
// autogenered slug? And we need a generator form, not an upload form for textures... Need a detail
// panel for each texture where we can capture prompts and edit them and regenerate textures (don't
// blow away old copies until an explicit save operation happens!)"
//
// The draft rules — that a regeneration writes nothing live and that saving keeps what it replaced
// — are checked in tools/assetsvc/materials.test.mjs, where they can be tested without a GPU. What
// is checked HERE is the part that only exists in a browser: that the mode control actually changes
// what is on the stage, and that editing a prompt is a draft until it is saved.
//
//   node probes/corridor-materials.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const SVC = process.env.ASSETSVC ?? 'http://localhost:8790'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector('.seg')
await page.click('.seg[data-value="assets"]')
// the library is a full-width pane now, not a dialog over the map: the Assets tab IS the catalog
await page.waitForSelector('#assets .asset-row', { timeout: 30000 })
await page.evaluate(() => [...document.querySelectorAll('#assets [role="tab"], #assets .tab')].find((n) => /Materials/.test(n.textContent))?.click())
await page.waitForSelector('.material-row', { timeout: 20000 })
await page.waitForFunction(() => window.__meshview?.size, null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(800)

/* ---- 1 · one way to make it bigger, not two ---- */
const bigButtons = await page.locator('.material-side .panel-actions button').allTextContents()
say('controls beside the stage', bigButtons)
if (bigButtons.filter((t) => /pop out|the maps|close up/i.test(t)).length !== 1) {
  fail.push(`${bigButtons.join(' / ')} — there should be exactly one "make it bigger"`)
}

/* ---- 2 · the mode control changes what is on the stage ---- */
const modes = await page.locator('.material-side .segmented button, .material-side .seg').allTextContents()
say('modes', modes)
for (const want of ['tiled', 'albedo', 'normal']) {
  if (!modes.some((m) => m.trim() === want)) fail.push(`no “${want}” view`)
}
const tiled = await page.evaluate(() => window.__meshview.capture())
await page.locator('.material-side button', { hasText: 'normal' }).first().click()
await page.waitForTimeout(2500)
const normal = await page.evaluate(() => window.__meshview.capture())
say('tiled vs normal', { tiled, normal })
if (Math.abs(tiled.mean - normal.mean) < 3) fail.push('switching to the normal map changed nothing on the stage')
// a normal map is mostly flat-facing: lavender, and much brighter than a dark brick wall
await page.locator('.material-side button', { hasText: 'tiled' }).first().click()
await page.waitForTimeout(2000)

/* ---- 3 · the prompt is there, and editing it is a draft ---- */
const labels = await page.locator('.material-right .group .field .field-label').allTextContents()
say('form fields', labels)
for (const want of ['name', 'category', 'metres per tile', 'prompt', 'seed']) {
  if (!labels.includes(want)) fail.push(`no “${want}” field`)
}
if (labels.includes('id')) fail.push('the form still asks for a raw id on an existing texture')

const id = await page.evaluate(() => document.querySelector('.material-row.on')?.dataset.id)
const before = await fetch(`${SVC}/materials`).then((r) => r.json()).then((j) => j.materials.find((m) => m.id === id))
say('editing', id)
const box = page.locator('.material-right .group textarea').first()
await box.fill(`${before.prompt} AND A PROBE EDIT`)
await box.blur()
await page.waitForTimeout(600)
const saveBtn = page.locator('.material-right button', { hasText: 'Save changes' })
say('save appeared', await saveBtn.count())
if (!(await saveBtn.count())) fail.push('editing the prompt offered no way to save it')
const mid = await fetch(`${SVC}/materials`).then((r) => r.json()).then((j) => j.materials.find((m) => m.id === id))
say('service untouched', !String(mid.prompt).includes('PROBE EDIT'))
if (String(mid.prompt).includes('PROBE EDIT')) fail.push('the prompt was written on blur, with no explicit save')

if (await saveBtn.count()) {
  await saveBtn.click()
  await page.waitForTimeout(1500)
  const after = await fetch(`${SVC}/materials`).then((r) => r.json()).then((j) => j.materials.find((m) => m.id === id))
  say('saved', String(after.prompt).includes('PROBE EDIT'))
  if (!String(after.prompt).includes('PROBE EDIT')) fail.push('Save changes did not write the prompt')
  // put it back
  await fetch(`${SVC}/materials/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: before.prompt }) })
}

/* ---- 4 · a new texture is named, not id'd ---- */
await page.locator('.material-side button', { hasText: 'New texture' }).click()
await page.waitForTimeout(600)
const newLabels = await page.locator('.material-right .group .field .field-label').allTextContents()
say('new-texture fields', newLabels)
if (!newLabels.includes('name') || !newLabels.includes('id')) fail.push('a new texture should take a name AND show the id it derives')
// NOT `.material-right input`: the search box lives in this column too, above the form
const nameBox = page.locator('.material-right .group input').first()
await nameBox.fill('Probe Cobble Stone')
await nameBox.dispatchEvent('change')
await page.waitForTimeout(500)
const derived = await page.locator('.material-right .group input').nth(1).inputValue()
say('id derived', derived)
if (derived !== 'probe_cobble_stone') fail.push(`the id came out as ${JSON.stringify(derived)}`)
const drawBtn = await page.locator('.material-right button', { hasText: 'Draw it' }).count()
say('generator offered', drawBtn > 0)
if (!drawBtn) fail.push('a new texture cannot be generated — only uploaded')

if (errs.length) { say('page errors', errs.slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: one viewer with modes, a prompt you can edit, and a save that means something')
await browser.close()
process.exit(fail.length ? 1 : 0)
