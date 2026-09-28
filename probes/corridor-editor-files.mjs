// Can you keep more than one file, and does what you typed survive?
//
// Four claims, all of which were false on 2026-09-28 and none of which the DOM can answer on its
// own (Rich: "typing into the editor, as soon as I press n, takes me to the define screen. Also it
// does not store state and what ever was typed is wiped when you move away." / "How are you
// supposed to manage multiple files in the editor, there is no folders and no file system and no
// tabs"):
//
//   1  A KEYSTROKE IN THE EDITOR IS NOT A SHORTCUT. Monaco 0.57 takes text through an EditContext
//      div, which is neither an input nor contenteditable, so `typing()` said no and single-letter
//      shortcuts fired mid-word. Checked by typing the word and reading the mode back.
//
//   2  FOLDERS. A program id is a path now, so `levels/a` and `levels/b` are two files in one
//      folder rather than two slugs with a slash they were not allowed to contain.
//
//   3  TABS. Two files open at once, each keeping its own buffer.
//
//   4  NOTHING IS LOST. Type, leave the tab, come back, reload the page: it is still there. This
//      is the one that matters — the rest is navigation, this is somebody's work.
//
//   node probes/corridor-editor-files.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const A = 'probe-tree/alpha'
const B = 'probe-tree/beta'
const TYPED = '// typed into alpha and never saved'

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } })
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(30)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

// make the two files through the API, so the probe is about the editor and not about a dialog
for (const id of [A, B]) {
  const r = await fetch(`http://localhost:8780/api/programs/${id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: `// ${id}\nexport default {}\n` }),
  })
  if (!r.ok) { console.log(`FAIL: could not create ${id}: ${r.status} ${await r.text()}`); await browser.close(); process.exit(1) }
}

const openProgram = async (p) => {
  await p.waitForSelector('.seg')
  await p.click('.seg[data-value="program"]')
  await p.waitForSelector('#panel .filetree', { timeout: 20000 })
}

await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 60000 })
await openProgram(page)

/* ---- 2 · folders ---- */
const dirs = await page.locator('#panel .tree-dir .tree-name').allTextContents()
say('folders in the tree', dirs)
if (!dirs.includes('probe-tree')) fail.push('a program id with a slash in it did not make a folder')

/* ---- 3 · two tabs ---- */
const openFile = async (id) => {
  const leaf = `${id.split('/').pop()}.ts`
  await page.locator('#panel .tree-file .tree-name', { hasText: leaf }).first().click()
  await page.waitForFunction((n) => window.__apexProgram?.open?.().includes(n), id, { timeout: 30000 })
}
await openFile(A)
await openFile(B)
await page.waitForTimeout(500)
const tabs = await page.locator('.code-tab-name').allTextContents()
say('tabs', tabs)
if (tabs.length !== 2) fail.push(`${tabs.length} tabs for two open files`)

/* ---- 1 · typing is not a shortcut ---- */
await page.evaluate((n) => window.__apexProgram.openFile(n), A)
await page.waitForTimeout(400)
await page.locator('.code-stack > div:not([hidden]) .view-lines').click()
await page.waitForTimeout(300)
await page.keyboard.press('End')
await page.keyboard.type(TYPED)
await page.waitForTimeout(400)
const mode = await page.evaluate(() => [...document.querySelectorAll('.seg.on')].map((n) => n.dataset.value))
say('mode after typing', mode)
if (!mode.includes('program')) fail.push(`typing moved the editor to ${mode.join('/')} — a letter is still a shortcut`)
const typed = await page.evaluate(() => window.__apexProgram.value())
say('the text arrived', typed.includes(TYPED))
if (!typed.includes(TYPED)) fail.push('what was typed did not reach the buffer at all')

/* ---- 4a · leave the tab and come back ---- */
await page.click('.seg[data-value="bake"]')
await page.waitForTimeout(700)
await page.click('.seg[data-value="program"]')
await page.waitForTimeout(1200)
const afterTab = await page.evaluate(() => ({ value: window.__apexProgram.value(), open: window.__apexProgram.open(), dirty: window.__apexProgram.dirty() }))
say('after another tab', { kept: afterTab.value.includes(TYPED), open: afterTab.open.length, dirty: afterTab.dirty })
if (!afterTab.value.includes(TYPED)) fail.push('leaving the tab threw away what was typed')
if (afterTab.open.length !== 2) fail.push(`${afterTab.open.length} tabs survived a tab change, not 2`)
if (!afterTab.dirty.includes(A)) fail.push('the unsaved file is not marked unsaved')

/* ---- 4b · and a page reload ---- */
await page.reload({ waitUntil: 'networkidle', timeout: 60000 })
await openProgram(page)
await page.waitForFunction(() => (window.__apexProgram?.open?.() ?? []).length > 0, null, { timeout: 30000 })
await page.waitForTimeout(800)
const afterReload = await page.evaluate(() => ({ value: window.__apexProgram.value(), open: window.__apexProgram.open(), id: window.__apexProgram.id }))
say('after a reload', { kept: afterReload.value.includes(TYPED), open: afterReload.open, on: afterReload.id })
if (afterReload.open.length !== 2) fail.push(`${afterReload.open.length} tabs came back after a reload, not 2`)
if (!afterReload.value.includes(TYPED)) fail.push('a page reload threw away what was typed — the draft is not being kept')

/* ---- and the volume was NOT written to ---- */
const onDisk = await fetch(`http://localhost:8780/api/programs/${A}`).then((r) => r.json())
say('saved copy still clean', !onDisk.source.includes(TYPED))
if (onDisk.source.includes(TYPED)) fail.push('an unsaved buffer reached the volume — the editor is saving as you type')

if (errs.length) { say('page errors', errs.slice(0, 3)); fail.push(`${errs.length} page errors`) }
for (const id of [A, B]) await fetch(`http://localhost:8780/api/programs/${id}`, { method: 'DELETE' })
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: folders, tabs, and nothing typed was lost')
await browser.close()
process.exit(fail.length ? 1 : 0)
