// Does a dialog open, close, and leave the tab alive?
//
// Two bugs on 2026-09-28, from the same file, in opposite directions:
//
//   `open()` used to close whatever was already open, and `ask` is a dialog — so asking a question
//   from inside a panel closed the panel that raised it. Dialogs are a stack now.
//
//   Then `beforeClose` was added to guard unsaved edits. Its answer arrives in a microtask, so
//   acting on it means calling `close()` again — which asks again. The guard was cleared before
//   that second call: an unbounded chain of microtasks, no timer ran, nothing painted, and the tab
//   had to be killed (Rich: "Closing the assets form freezes the tab... you get the aw snap!
//   screen").
//
// WHICH IS WHY THIS ASKS WHETHER THE PAGE IS STILL ANSWERING as well as whether the dialog is
// gone. A wedged tab and a dialog that declined to close are the same thing to a selector.
//
//   node probes/corridor-dialogs.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

/** Is the page still running its own timers? A frozen tab answers nothing at all. */
const answering = async (ms = 4000) => {
  const r = await Promise.race([
    page.evaluate(() => new Promise((res) => setTimeout(() => res('alive'), 120))),
    new Promise((res) => setTimeout(() => res('WEDGED'), ms)),
  ])
  return r === 'alive'
}
const dialogs = () => page.evaluate(() => document.querySelectorAll('.dialog').length)
const settle = (n) => page.waitForFunction((want) => document.querySelectorAll('.dialog').length === want, n, { timeout: 6000 })
  .then(() => true).catch(() => false)

await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector('.seg', { timeout: 30000 })
await page.click('.seg[data-value="assets"]')
await page.waitForSelector('#assets .asset-row', { timeout: 30000 })
await page.waitForTimeout(800)

/* ---- a question raised from a panel ---- */
await page.evaluate(() => document.querySelector('#assets .asset-row')?.click())
await page.waitForTimeout(900)
await page.evaluate(() => {
  const s = document.querySelector('#assets .asset-detail select')
  const opt = [...s.options].find((o) => /new class/.test(o.textContent))
  s.value = opt.value
  s.dispatchEvent(new Event('change', { bubbles: true }))
})
say('question opened', await settle(1) ? await dialogs() : 'never appeared')
if (await dialogs() !== 1) fail.push('choosing “new class…” opened no dialog')

/* ---- Escape closes it, and the page survives ---- */
await page.keyboard.press('Escape')
const gone = await settle(0)
const alive = await answering()
say('after Escape', { dialogs: await dialogs(), pageAnswering: alive })
if (!alive) fail.push('the page stopped answering — closing wedged the tab')
if (!gone) fail.push('Escape did not close it')

/* ---- and a dialog with a form in it, closed by its own X ---- */
await page.evaluate(() => [...document.querySelectorAll('#assets [role="tab"], #assets .tab')].find((n) => /Materials/.test(n.textContent))?.click())
await page.waitForTimeout(2500)
await page.evaluate(() => [...document.querySelectorAll('#assets button')].find((b) => /New texture/.test(b.textContent))?.click())
await page.waitForTimeout(1200)
// it needs a name before it will upload anything — "give it a name first" is the right answer to
// an anonymous upload, and it is a toast rather than a dialog
await page.evaluate(() => {
  const i = document.querySelector('#assets .material-right .group input')
  i.value = 'Probe Cobble'
  i.dispatchEvent(new Event('input', { bubbles: true }))
  i.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForTimeout(500)
await page.evaluate(() => [...document.querySelectorAll('#assets button')].find((b) => /Upload instead/.test(b.textContent))?.click())
const opened = await settle(1)
say('upload dialog', opened ? 'open' : 'never appeared')
if (!opened) fail.push('the upload dialog did not open')
else {
  await page.evaluate(() => [...document.querySelectorAll('.dialog-head button')].pop()?.click())
  const shut = await settle(0)
  const still = await answering()
  say('after its X', { dialogs: await dialogs(), pageAnswering: still })
  if (!still) fail.push('closing it wedged the tab')
  if (!shut) fail.push('it would not close')
}

if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: they open, they close, and the tab is still alive afterwards')
await browser.close()
process.exit(fail.length ? 1 : 0)
