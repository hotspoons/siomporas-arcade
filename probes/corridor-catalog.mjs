// The asset catalog: can you make one, edit one, and not lose what you typed?
//
// Five complaints on 2026-09-28, all in this one dialog:
//
//   "why after submitting the new item does it just disappear?" — `Dialog.open()` closed whatever
//   was already open, and `ask` is a dialog, so pressing "New item" closed the catalog and the
//   item was created into nothing. Dialogs are a stack now.
//
//   "This form needs some work, it is super cramped... just place it in the catalog directly, then
//   move it in the listing order once the slug is set" — so the new item is a row in the list and
//   a form in the detail pane, and the row sorts by the id as it is typed.
//
//   "why can't we have a name field and an auto-generated id from the slug" — the id follows the
//   name until the id itself is edited.
//
//   "if editing an item we need a save changes button and confirmation before navigating away" —
//   every field used to PUT on blur.
//
//   "we need to be able to set the catagory like traffic, hero car, furnature, etc."
//
//   node probes/corridor-catalog.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const NAME = 'Probe Roadside Mailbox'
const ID = 'probe-roadside-mailbox'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

// a run that failed halfway leaves the item behind, and "it already exists" is a different
// test from the one this is trying to run
await fetch(`http://localhost:8790/catalog/${ID}`, { method: 'DELETE' }).catch(() => {})

await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector('.seg')
await page.click('.seg[data-value="assets"]')
// the library is a full-width pane now, not a dialog over the map: the Assets tab IS the catalog
await page.waitForSelector('#assets .asset-row', { timeout: 30000 })
await page.waitForTimeout(1200)

const rows = () => page.locator('.asset-row').count()
const ids = () => page.locator('.asset-row .asset-row-id').allTextContents()
say('rows to start', await rows())
const pushes = await page.evaluate(() => [...document.querySelectorAll('#assets .asset-pane-bar button')].filter((b) => /Push to S3/.test(b.textContent)).length)
say('push-to-s3 in the toolbar', pushes)
if (pushes) fail.push('a deployment button is still beside “New item”')

/* ---- 1 · new item, in the catalog, not in a modal ---- */
const before = await rows()
await page.evaluate(() => [...document.querySelectorAll('#assets .asset-pane-bar button')].find((b) => /New item/.test(b.textContent))?.click())
await page.waitForTimeout(500)
// the library is a pane now, so the right number of dialogs is NONE: naming a new item happens
// in the list and the detail pane, not in a modal over them
say('dialogs open', await page.locator('.dialog').count())
if (await page.locator('.dialog').count() !== 0) fail.push('“New item” opened a dialog — it should fill in the catalog itself')
if (await rows() !== before + 1) fail.push('no new row appeared in the list')

/* ---- 2 · the id follows the name, and the row walks to where it will live ---- */
const nameInput = page.locator('.asset-detail input').first()
await nameInput.click()
await nameInput.type(NAME, { delay: 12 })
await page.waitForTimeout(500)
const derived = await page.locator('.asset-detail input').nth(1).inputValue()
say('id derived from the name', derived)
if (derived !== ID) fail.push(`the id came out as ${JSON.stringify(derived)}, not ${ID}`)

const order = await ids()
const at = order.indexOf(ID)
const sorted = [...order].sort()
say('row position', { at, of: order.length, sortedHere: sorted.indexOf(ID) })
if (at < 0) fail.push('the new row does not show the id being typed')
else if (at !== sorted.indexOf(ID)) fail.push(`the new row sits at ${at} but sorts at ${sorted.indexOf(ID)} — it did not move`)

/* ---- 3 · the class ---- */
const classes = await page.locator('.asset-detail select').first().locator('option').allTextContents()
say('classes offered', classes.slice(0, 6).join(', '))
for (const want of ['hero car', 'traffic', 'furniture']) {
  if (!classes.includes(want)) fail.push(`no “${want}” class to choose`)
}
if (!classes.some((c) => /new class/.test(c))) fail.push('no way to add a class')
await page.locator('.asset-detail select').first().selectOption({ label: 'traffic' })

await page.locator('.asset-detail button', { hasText: 'Create' }).click()
await page.waitForTimeout(1800)
say('after Create', { dialogs: await page.locator('.dialog').count(), rows: await rows(), stillThere: (await ids()).includes(ID) })
if (await page.locator('.dialog').count() !== 0) fail.push('Create left a dialog open')
if (!(await ids()).includes(ID)) fail.push('the created item is not in the list')

/* ---- 4 · editing is a draft until you save it ---- */
say('detail fields', await page.evaluate(() => [...document.querySelectorAll('.asset-detail .field')].map((f) => f.querySelector('.field-label')?.textContent)))
say('selected row', await page.locator('.asset-row.on .asset-row-id').textContent().catch(() => 'none'))
const subject = page.locator('.asset-detail input').first()
await subject.fill('probe subject edited')
await subject.blur()
await page.waitForTimeout(400)
const bar = page.locator('.asset-save')
say('save bar showing', await bar.isVisible())
if (!(await bar.isVisible())) fail.push('no “Save changes” bar appeared after an edit')
const onDisk = await fetch(`http://localhost:8790/catalog/${ID}`).then((r) => r.json())
say('service still has', onDisk.subject)
if (onDisk.subject === 'probe subject edited') fail.push('the edit was written on blur — there is nothing for Save to do')

// navigating away asks first
await page.locator('.asset-row').first().click()
await page.waitForTimeout(500)
const asked = await page.locator('.dialog', { hasText: 'Unsaved changes' }).count()
say('asked before leaving', asked > 0)
if (!asked) fail.push('switching items threw the edit away without asking')
await page.locator('.dialog', { hasText: 'Unsaved changes' }).locator('button', { hasText: 'Discard' }).click()
await page.waitForTimeout(400)

// and Save does write
await page.locator('.asset-row', { hasText: ID }).click()
await page.waitForTimeout(600)
const s2 = page.locator('.asset-detail input').first()
await s2.fill('probe subject saved')
await s2.blur()
await page.waitForTimeout(300)
await page.locator('.asset-save button', { hasText: 'Save changes' }).click()
await page.waitForTimeout(1200)
const after = await fetch(`http://localhost:8790/catalog/${ID}`).then((r) => r.json())
say('saved', { subject: after.subject, kind: after.kind })
if (after.subject !== 'probe subject saved') fail.push('Save did not write the edit')
if (after.kind !== 'traffic') fail.push(`the class was not kept: ${after.kind}`)

await fetch(`http://localhost:8790/catalog/${ID}`, { method: 'DELETE' })
if (errs.length) { say('page errors', errs.slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: made in the list, named into place, and nothing saved until you say so')
await browser.close()
process.exit(fail.length ? 1 : 0)
