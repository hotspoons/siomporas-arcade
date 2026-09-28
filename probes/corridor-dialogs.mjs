// Do dialogs stack, and does closing one actually close it?
//
// Both of these were broken by the same file on the same day, in opposite directions:
//
//   `open()` used to close whatever was already open, so `ask` — which is a dialog — closed the
//   panel that raised it. Pressing "New item" in the catalog made the catalog vanish.
//
//   Then `beforeClose` was added to guard unsaved edits, and its answer arrives in a microtask, so
//   acting on it means calling `close()` again — which asks again. The guard was cleared before
//   that second call, so a `beforeClose` that says yes produced an unbounded chain of microtasks:
//   the queue never drained, timers never ran, nothing painted (Rich, 2026-09-28: "Closing the
//   assets form freezes the tab and you need to wait to kill it so you can get the aw snap!
//   screen").
//
// THE SECOND ONE IS WHY THIS PROBE ASKS WHETHER THE PAGE IS STILL ANSWERING, not just whether the
// dialog is gone. A wedged tab and a dialog that declined to close look identical from a selector.
//
//   node probes/corridor-dialogs.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
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

await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector('.seg')
await page.click('.seg[data-value="assets"]')
await page.locator('#panel button', { hasText: 'Catalog & generate' }).click()
await page.waitForSelector('.dialog', { timeout: 10000 })
await page.waitForTimeout(1500)
say('opened', await page.locator('.dialog').count())

/* ---- a question opens ON TOP, it does not replace ---- */
//
// "new class…" is the one place in here that still raises an `ask` from inside the panel, which
// is exactly the shape that used to close the panel underneath it. (Making a new item no longer
// opens a dialog at all — it fills in the catalog, which is the other half of the same fix.)
await page.locator('.asset-row').first().click()
await page.waitForTimeout(900)
await page.locator('.asset-detail select').first().selectOption({ label: 'new class…' })
await page.waitForTimeout(700)
const stacked = await page.locator('.dialog').count()
say('with a question open', stacked)
if (stacked !== 2) fail.push(`${stacked} dialogs — a question should sit on top of the panel that raised it`)
await page.keyboard.press('Escape')
// WAIT FOR IT TO SETTLE rather than guessing: the close transition takes ~200ms and the node is
// removed after it, so a count read on a fixed timer reports whichever side of that it lands on
const settled = await page.waitForFunction(() => document.querySelectorAll('.dialog').length === 1, null, { timeout: 5000 }).then(() => true).catch(() => false)
say('after Escape', await page.locator('.dialog').evaluateAll((ns) => ns.map((n) => n.getAttribute('aria-label'))))
if (!settled) fail.push('Escape did not close the question on top')

/* ---- closing closes, and the tab survives it ---- */
const close = page.locator('.dialog-head button').last()
await close.click({ timeout: 8000 }).catch((e) => fail.push(`the close button never became clickable: ${e.message.split('\n')[0]}`))
await page.waitForTimeout(1200)
const alive = await answering()
const left = alive ? await page.locator('.dialog').count() : -1
say('after closing', { pageAnswering: alive, dialogs: left })
if (!alive) fail.push('the page stopped answering — closing wedged the tab')
else if (left !== 0) fail.push(`${left} dialogs still open after pressing close`)

/* ---- and it can be opened again ---- */
if (alive) {
  await page.locator('#panel button', { hasText: 'Catalog & generate' }).click()
  await page.waitForTimeout(1200)
  say('reopened', await page.locator('.dialog').count())
  if (await page.locator('.dialog').count() !== 1) fail.push('it would not open again')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
  const stillAlive = await answering()
  say('Escape closes too', { pageAnswering: stillAlive, dialogs: stillAlive ? await page.locator('.dialog').count() : -1 })
  if (!stillAlive) fail.push('Escape wedged the tab')
  else if (await page.locator('.dialog').count() !== 0) fail.push('Escape did not close it')
}

if (errs.length) { say('page errors', errs.slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: they stack, they close, and the tab is still alive afterwards')
await browser.close()
process.exit(fail.length ? 1 : 0)
