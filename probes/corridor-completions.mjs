// Does the editor tell you what can go here?
//
// Rich, 2026-09-28: "an LSP for typescript, javascript and json would be nice so we can see what
// options exist as we type" and "We need autocompletion for imports and other TS libraries that
// are part of the core package plus anything referenced from the program's scope".
//
// THE SERVICE WAS NEVER THE PROBLEM. `monaco-editor/editor/editor.api.js` registers no editor
// CONTRIBUTIONS — no suggest controller, no hover, no find — so the completions were computed and
// had nowhere to go. Ctrl-Space did nothing at all. Which is why this probe reads the suggest
// widget's rows rather than calling the TypeScript worker: asking the worker would have passed on
// the day the editor showed nothing.
//
// Five kinds, and they fail for different reasons:
//   a member          the service knows the type of `api`
//   a core package    the generated declarations are loaded and laid out where TS can resolve them
//   its exports       the same, through a named import
//   a sibling's path  ui/codeeditor.ts provides these: TS cannot, having no directory to list
//   its exports       every file on the volume is in the compilation, not just the open ones
//
//   node probes/corridor-completions.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const API = process.env.WORLDEDITOR ?? 'http://localhost:8780'
const LIB = 'zzprobe/helpers.ts'
const MAIN = 'zzprobe-main.ts'

const put = (id, source) => fetch(`${API}/api/programs/${id}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source }),
})
await put(LIB, 'export const chaseSpeed = 42\nexport function startChase(n: number) { return n * 2 }\n')
await put(MAIN, "import { defineGame } from '@apex/program'\n\nexport default defineGame({ setup(api) { api.goal('go') } })\n")

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(22)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForSelector('.seg')
await page.click('.seg[data-value="program"]')
await page.waitForSelector('#panel .filetree', { timeout: 30000 })
await page.waitForFunction(() => !!window.__apexProgram, null, { timeout: 30000 })
await page.evaluate((id) => window.__apexProgram.openFile(id), MAIN)
await page.waitForTimeout(7000)

/** Put the text in the buffer with the caret where the `|` is, and read the suggestions. */
async function suggest(marked) {
  const at = marked.indexOf('|')
  const text = marked.replace('|', '')
  await page.evaluate((t) => window.__apexProgram.setValue(t), text)
  await page.waitForTimeout(500)
  await page.locator('.code-stack > div:not([hidden]) .view-lines').click()
  await page.keyboard.press('Control+End')
  for (let i = 0; i < text.length - at; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Control+Space')
  await page.waitForTimeout(2500)
  const out = await page.evaluate(() => {
    const w = document.querySelector('.suggest-widget')
    return {
      visible: !!w && w.getBoundingClientRect().height > 0,
      rows: [...document.querySelectorAll('.suggest-widget .monaco-list-row .label-name, .suggest-widget .monaco-list-row')]
        .map((n) => (n.querySelector?.('.monaco-highlighted-label')?.textContent ?? n.textContent).trim())
        .slice(0, 40),
    }
  })
  await page.keyboard.press('Escape')
  return out
}

const check = async (what, marked, wanted, forbidden = []) => {
  const r = await suggest(marked)
  const has = (n) => r.rows.some((row) => row === n || row.startsWith(n))
  say(what, { visible: r.visible, rows: r.rows.slice(0, 5) })
  if (!r.visible) { fail.push(`${what}: no suggestions appeared at all`); return }
  for (const n of wanted) if (!has(n)) fail.push(`${what}: “${n}” was not offered`)
  for (const n of forbidden) if (has(n)) fail.push(`${what}: “${n}” should not be offered here`)
}

// the list is virtualised, so only what is on screen is in the DOM: `zone` sorts last and is
// asked for by typing a prefix instead, which also proves the list filters
await check('a member', "import { defineGame } from '@apex/program'\nexport default defineGame({ setup(api) { api.|", ['goal', 'hide', 'award'])
await check('a member, filtered', "import { defineGame } from '@apex/program'\nexport default defineGame({ setup(api) { api.zo|", ['zone'])
await check('a core package', "import { defineGame } from '@apex/|'", ['@apex/program', '@apex/actors'], ['chaseSpeed'])
await check('its exports', "import { | } from '@apex/program'", ['GameApi', 'HIDEABLE'])
await check("a sibling's path", "import { chaseSpeed } from './zzprobe/|'", ['./zzprobe/helpers'], ['chaseSpeed'])
await check("a sibling's exports", "import { | } from './zzprobe/helpers'", ['chaseSpeed', 'startChase'])

/* and JSON has a service of its own */
await page.evaluate((id) => window.__apexProgram.openFile(id), 'zzprobe/data.json').catch(() => {})
if (errs.length) { say('page errors', errs.slice(0, 3)); fail.push(`${errs.length} page errors`) }

for (const id of [LIB, MAIN]) await fetch(`${API}/api/programs/${id}`, { method: 'DELETE' })
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: members, packages, their exports, sibling paths and sibling exports')
await browser.close()
process.exit(fail.length ? 1 : 0)
