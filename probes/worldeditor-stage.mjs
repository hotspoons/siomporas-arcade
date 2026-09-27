// Can a person make a level in the editor, and does it refuse the things it should?
//
// Every service behind the Stage panel existed for hours and was reachable only with curl, which
// is the same as not existing. This drives the UI: open Stage, make a level, put a condition in it
// that names a fact the engine does not measure, and check the panel says so BEFORE saving —
// because the whole point of the validator is that the refusal arrives in front of the person
// writing it rather than at 2 a.m. when the event never fires.
//
//   node probes/worldeditor-stage.mjs --ui http://localhost:5212/world.html
import { chromium } from 'playwright'
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const UI = arg('ui', 'http://localhost:5212/world.html')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => { errors.push(e.message.slice(0, 200)); console.log('pageerror', e.message.slice(0, 200)) })
await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.seg', { timeout: 30000 })

const tabs = await page.$$eval('.seg', (bs) => bs.map((b) => b.textContent.trim()))
await page.click('.seg[data-value="stage"]')
await page.waitForTimeout(1200)

const empty = await page.evaluate(() => document.getElementById('panel').textContent.slice(0, 160))
// start a new level
await page.click('#panel button:has-text("New level")')
await page.waitForTimeout(600)

const fields = await page.$$eval('#panel .field-label', (ls) => ls.map((l) => l.textContent.trim()))
const worldOptions = await page.$$eval('#panel select', (ss) => ss.map((s) => s.options.length))

// name it, and give the scenario a condition on a fact that does not exist
await page.fill('#panel .field.text input', 'probe-level')
await page.dispatchEvent('#panel .field.text input', 'change')
await page.waitForTimeout(400)
await page.click('#panel button:has-text("Add a scenario")')
await page.waitForTimeout(600)

const factsShown = await page.evaluate(() => [...document.querySelectorAll('#panel .panel-hint')].map((h) => h.textContent.trim()).find((t) => t.startsWith('Conditions read')) ?? null)

const inputs = await page.$$('#panel .field.text input')
// the last two text fields are `when` and `message`
await inputs[inputs.length - 2].fill('rage_meter >= 80')
await inputs[inputs.length - 2].dispatchEvent('change')
await page.click('#panel button:has-text("Add event")')
await page.waitForTimeout(900)

const refusal = await page.evaluate(() => [...document.querySelectorAll('#panel .panel-hint.warn')].map((h) => h.textContent.trim()))

console.log(JSON.stringify({ tabs, empty: empty.slice(0, 90), fields, worldOptions, factsShown, refusal }, null, 1))
await browser.close()
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1 }
if (errors.length) fail(`the page threw: ${errors[0]}`)
else if (!tabs.some((t) => /stage/i.test(t))) fail(`no Stage tab — the modes are ${tabs.join(', ')}`)
else if (!fields.includes('id') || !fields.includes('time')) fail(`the level form did not render: fields are ${fields.join(', ')}`)
else if (!factsShown || !/score/.test(factsShown)) fail(`the panel does not show the facts a condition may read: ${factsShown}`)
else if (!refusal.some((r) => /rage_meter/.test(r))) fail(`a condition on a fact nothing measures was accepted quietly: ${JSON.stringify(refusal)}`)
else console.log(`PASS: Stage is a tab, the level form renders (${fields.join(', ')}), the facts are shown to the person writing a condition, and "rage_meter >= 80" is refused in the panel — "${refusal.find((r) => /rage_meter/.test(r)).slice(0, 110)}"`)
