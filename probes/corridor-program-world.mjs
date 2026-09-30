// Can a program refer to the things somebody placed in the world?
//
// Rich, 2026-09-28: "Anything placed in the map should be accessible from the code editor as an
// instance that can be controlled in the ECS system (with instances listed in the editor we can
// reference from code by an id or something)... Can you set a much richer default that includes
// the full ECS scaffolding?"
//
// Two claims, both of which fail silently:
//
//   THE STARTER TEMPLATE HAS TO COMPILE AND RUN. A new file that opens with type errors, or that
//   dies on its first tick, is worse than an empty one — and neither shows up until somebody
//   presses Check. So this makes a new file and asks the editor's own toolkit about it.
//
//   THE IDS HAVE TO BE ON SCREEN. `api.placed('p-07')` is useless if the only way to learn that
//   `p-07` exists is to open placements.json in another tab.
//
//   node probes/corridor-program-world.mjs [world-slug]
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const API = process.env.WORLDEDITOR ?? 'http://localhost:8780'
const WORLD = process.argv[2] ?? 'arrowhead-farms-network'
const FILE = 'zzprobe-template'

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await fetch(`${API}/api/programs/${FILE}.ts`, { method: 'DELETE' })
const placed = await fetch(`http://localhost:${PORT}/sites/${WORLD}/placements.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
say('placements on disk', placed ? placed.items.length : 'none')

await page.goto(`http://localhost:${PORT}/world.html?world=${WORLD}#${WORLD}`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForSelector('.seg', { timeout: 30000 })
await page.click('.seg[data-value="program"]')
await page.waitForSelector('#panel .filetree', { timeout: 30000 })
await page.waitForFunction(() => !!window.__apexProgram, null, { timeout: 30000 })
await page.waitForTimeout(1500)

/* ---- the ids are listed, and clicking one types it ---- */
const listed = await page.evaluate(() => [...document.querySelectorAll('#panel .group')]
  .filter((g) => /In this world/.test(g.textContent ?? ''))
  .map((g) => [...g.querySelectorAll('.row .row-name')].map((n) => n.textContent))[0] ?? null)
say('ids in the panel', listed ? listed.slice(0, 5) : 'no such group')
if (placed?.items?.length) {
  if (!listed?.length) fail.push('a world with placements lists none of them beside the code')
  else if (!listed.includes(placed.items[0].id)) fail.push(`the panel lists ${listed[0]}, the document has ${placed.items[0].id}`)
}

/*
 * ---- and EVERY layer is listed, not just the placements ----
 *
 * Rich, 2026-09-29: *"Nothing shows up in the programming world listing except a set of apartments,
 * no traffic zones, no stunts, nothing."* The list read `placements.json` alone, so a world with
 * two painted zones and two loops in it looked like a world with one building. What is on disk is
 * the control: every layer the site actually has must have a row you can click.
 */
const layers = {}
for (const [name, file, key] of [['traffic', 'zones.json', 'zones'], ['stunt', 'stunts.json', 'fixtures'], ['race', 'courses.json', 'courses']]) {
  const doc = await fetch(`http://localhost:${PORT}/sites/${WORLD}/${file}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  layers[name] = doc?.[key] ?? []
}
say('layers on disk', Object.fromEntries(Object.entries(layers).map(([k, v]) => [k, v.length])))

const panel = await page.evaluate(() => {
  const g = [...document.querySelectorAll('#panel .group')].find((x) => /In this world/.test(x.textContent ?? ''))
  if (!g) return null
  return {
    headings: [...g.querySelectorAll('p.note')].map((n) => n.textContent),
    ids: [...g.querySelectorAll('.row .row-name')].map((n) => n.textContent),
    inserts: [...g.querySelectorAll('.row')].map((r) => r.title),
  }
})
say('panel headings', panel?.headings ?? 'no group')
for (const [name, items] of Object.entries(layers)) {
  if (!items.length) continue
  const id = items[0].id
  if (!panel?.ids?.includes(id)) fail.push(`the world has ${items.length} ${name} on disk and the panel lists none of them (${id} missing)`)
}
/*
 * AND EACH ROW INSERTS THE CALL THAT TAKES IT. A zone listed under `api.placed` is a row that
 * teaches you the wrong thing, which is worse than no row.
 */
if (layers.traffic.length) {
  const want = `insert api.traffic.set('${layers.traffic[0].id}'`
  if (!panel?.inserts?.some((t) => t?.startsWith(want))) fail.push(`a traffic zone's row does not insert api.traffic.set (${panel?.inserts?.join(' | ')})`)
}
if (layers.stunt.length) {
  const want = `insert api.stunts.show('${layers.stunt[0].id}'`
  if (!panel?.inserts?.some((t) => t?.startsWith(want))) fail.push('a stunt fixture\'s row does not insert api.stunts.show')
}

/* ---- a new file starts as something that compiles and runs ---- */
await page.locator('#panel .group header button, #panel .group-actions button').first().click()
await page.waitForTimeout(700)
await page.locator('.dialog input').last().fill(FILE)
await page.locator('.dialog button', { hasText: 'Create' }).click()
await page.waitForTimeout(10000)

const lines = await page.evaluate(() => window.__apexProgram.value().split('\n').length)
say('template lines', lines)
if (lines < 40) fail.push(`the starter is ${lines} lines — it was meant to be the scaffolding, not a stub`)

const diags = await page.evaluate(() => window.__apexProgram.check())
say('type errors', diags.length ? diags.slice(0, 3) : 'none')
if (diags.length) fail.push(`a new file opens with ${diags.length} type error(s): ${diags[0].message}`)

const dry = await page.evaluate(() => window.__apexProgram.dryRun())
say('dry run', dry && { ok: dry.ok, error: dry.error, transport: dry.transport, zones: dry.zones, played: dry.played })
if (!dry?.ok) fail.push(`the starter does not run: ${dry?.error ?? 'no result'}`)
else {
  if (!dry.transport) fail.push('the starter never chooses a transport, so it shows nothing about how the player moves')
  if (!dry.zones.length) fail.push('the starter declares no zone')
  if (!dry.goal) fail.push('the starter sets no goal text')
}

/* ---- and the ECS is really in it ---- */
const src = await page.evaluate(() => window.__apexProgram.value())
for (const want of ['@apex/actors', '@apex/actorworld', 'bitecs', 'api.placed', 'api.actors', 'query(']) {
  if (!src.includes(want)) fail.push(`the starter never mentions ${want}`)
}

if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
await fetch(`${API}/api/programs/${FILE}.ts`, { method: 'DELETE' })
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: the ids are listed, and a new file compiles and plays')
await browser.close()
process.exit(fail.length ? 1 : 0)
