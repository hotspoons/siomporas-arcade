// Does the Program pane's "In this world" list offer everything, and does what it inserts compile?
//
// Rich, 2026-10-10: *"The game editor has no sound or placed items (e.g. traffic zones, points)
// listing in the right, nor no assets we can reference from the library in case we want to spawn
// something at a point for a given condition."*
//
// Drives the real world editor: opens Program, opens a file that does NOT exist on the volume (so
// the template is in the buffer and nothing is ever saved — this probe writes nothing), then inserts
// one row of every group the world has — by clicking the row, and one by dragging it onto a line —
// and asks the panel's own TypeScript service whether the result typechecks. It fails loudly: a
// group missing, a count of zero, a type error, or the panel not saying "No type errors.".
//
//   PROBE_URL=http://127.0.0.1:5197 node probes/corridor-program-refs.mjs dc-metro-take-2 [shot.png]
import { chromium } from 'playwright'

const base = process.env.PROBE_URL ?? 'http://localhost:5186'
const world = process.argv[2] ?? 'crofton-triangle'
const shot = process.argv[3] ?? null
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await page.goto(`${base}/world.html?world=${world}#${world}`, { waitUntil: 'networkidle', timeout: 120000 })
await page.waitForSelector('.seg', { timeout: 30000 })
await page.evaluate(() => [...document.querySelectorAll('.seg')].find((x) => x.textContent?.trim() === 'Program')?.click())
await page.waitForFunction(() => !!window.__apexProgram, null, { timeout: 30000 })

// a path nobody has: the template, unsaved, in its own tab
const path = `scratch/refs-probe-${Date.now()}.ts`
await page.evaluate((p) => window.__apexProgram.openFile(p), path)
await page.waitForSelector('.refs-group', { timeout: 60000 })
await page.waitForFunction(() => document.querySelector('.note.ok')?.textContent === 'No type errors.' || document.querySelector('.row.diag'), null, { timeout: 60000 })

const groups = await page.evaluate(() => [...document.querySelectorAll('.refs-group')].map((g) => [g.dataset.kind, Number(g.querySelector('.refs-count')?.textContent)]))
say('groups', groups)
for (const k of ['traffic', 'point', 'sound', 'library']) {
  const g = groups.find(([kind]) => kind === k)
  if (!g || !(g[1] > 0)) fail.push(`no ${k} group, or it is empty`)
}
const heading = await page.evaluate(() => [...document.querySelectorAll('.group-head span')].map((s) => s.textContent).find((t) => t?.startsWith('In this world')))
say('heading', heading)

/** put the caret at the end of the template's goal line, inside setup(): an insert goes on the next line */
const caretInSetup = () => page.evaluate(() => {
  const h = window.__apexProgram
  const lines = h.value().split('\n')
  const at = lines.findIndex((l) => l.includes('api.goal('))
  h.caret(at + 1, lines[at].length + 1)
  return at + 1
})

// one row of every group, by CLICKING it — the shut ones opened first, as a person would
const inserted = []
for (const [kind] of groups) {
  await caretInSetup()
  const sec = page.locator(`.refs-group[data-kind="${kind}"]`)
  if (await sec.evaluate((s) => s.classList.contains('shut'))) await sec.locator('.refs-head').click()
  const row = sec.locator('.refs-row > .row').first()
  const id = await row.locator('.row-name').textContent()
  await row.click()
  inserted.push(`${kind}:${id}`)
}
say('clicked in', inserted)

// and one by DRAGGING a row onto the first line of setup's body
await caretInSetup()
const target = page.locator('.code-host:not([hidden]) .view-line').nth(14)
const dragRow = page.locator('.refs-group[data-kind="point"] .refs-row > .row').first()
const before = await page.evaluate(() => window.__apexProgram.value().length)
await dragRow.dragTo(target)
await page.waitForTimeout(300)
const after = await page.evaluate(() => window.__apexProgram.value().length)
say('drag grew the file by', after - before)
if (!(after > before)) fail.push('dropping a row on the code inserted nothing')

const diags = await page.evaluate(() => window.__apexProgram.check())
await page.waitForTimeout(300)
say('type errors after inserts', diags.filter((d) => d.severity === 'error').map((d) => `${d.line}: ${d.message}`))
if (diags.some((d) => d.severity === 'error')) fail.push('the inserted code does not typecheck')
const okNote = await page.evaluate(() => document.querySelector('.note.ok')?.textContent ?? null)
say('panel says', okNote)
if (okNote !== 'No type errors.') fail.push('the panel does not say "No type errors."')

// the inserted code, indented into setup — what a person would see
const code = await page.evaluate(() => window.__apexProgram.value())
const from = code.indexOf('api.goal(')
console.log(code.slice(from, from + 1600).split('\n').map((l) => `    | ${l}`).join('\n'))

// it RUNS, too: five seconds against the stub world, no throw
const dry = await page.evaluate(() => window.__apexProgram.dryRun())
say('dry run', { ok: dry?.ok, error: dry?.error, played: dry?.played })
if (!dry?.ok) fail.push(`the dry run failed: ${dry?.error}`)

// the search: "crash" finds the crash slots and nothing in the other groups
const box = page.locator('.refs-filter input')
await box.fill('crash')
const found = await page.evaluate(() => [...document.querySelectorAll('.refs-group:not([hidden])')].map((g) => [g.dataset.kind, [...g.querySelectorAll('.refs-row:not([hidden]) .row-name')].map((n) => n.textContent)]))
say('search "crash"', found)
if (!found.length || found.some(([kind]) => kind !== 'sound' && kind !== 'library')) fail.push('the search did not narrow to the crash sounds')

// the ▶ on a sound row plays it through the editor's preview player. Twice: the first press may
// only start the bank loading (and says so), which is the soundpicker's own behaviour
const play = page.locator('.refs-group[data-kind="sound"] .refs-play').first()
await play.click()
await page.waitForFunction(async () => (await import('/src/editor/library/soundpicker.ts')).previewSfx().stats?.().bankLoaded, null, { timeout: 20000 }).catch(() => {})
await play.click()
await page.waitForTimeout(1500)
const played = await page.evaluate(async () => (await import('/src/editor/library/soundpicker.ts')).previewSfx().stats?.() ?? null)
say('preview after ▶', played)
await box.fill('')

if (shot) {
  // the sounds open and the zones shut, so the shot shows the ▶ rows
  for (const [kind, open] of [['sound', true], ['traffic', false], ['library', false]]) {
    const sec = page.locator(`.refs-group[data-kind="${kind}"]`)
    if ((await sec.count()) && (await sec.evaluate((s) => s.classList.contains('shut'))) === open) await sec.locator('.refs-head').click()
  }
  await page.screenshot({ path: shot })
  say('screenshot', shot)
}
say('page errors', errs)
if (errs.length) fail.push(`page errors: ${errs.join(' | ')}`)
await browser.close()
if (fail.length) {
  console.log(`\nFAIL\n  ${fail.join('\n  ')}`)
  process.exit(1)
}
console.log('\nPASS')
