// Does the program editor actually typecheck, compile and run a program?
//
// This is the probe for the toolkit Rich asked for: "would be great to have a tool kit to test
// types and verify everything builds and all that too." Every part of it fails silently.
//
//   the TS service    without MonacoEnvironment.getWorker it never starts, and the editor looks
//                     like a text box with colouring — no squiggles, no completions, no message
//   the declarations  generated from the real sources; if they do not load, everything typechecks,
//                     including `api.hide('mnimap')`
//   the emit          TypeScript will happily emit JavaScript for a file full of type errors
//   the dry run       a module whose import specifier does not resolve throws at import, which in
//                     a production build is the ONLY place the path-based version would have shown
//
// So this drives the real page: write a correct program and a wrong one, and check that the
// service says so about the right one.
//
//   node probes/corridor-program-editor.mjs
import { chromium } from 'playwright'

const url = process.env.PROBE_URL ?? 'http://localhost:5185/world.html'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })

const fail = []
const say = (k, v) => console.log(`${k.padEnd(30)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

// into the Program mode
await page.waitForSelector('.seg', { timeout: 30000 })
const opened = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.seg')].find((x) => x.textContent?.trim() === 'Program')
  if (!b) return false
  b.click()
  return true
})
if (!opened) { console.log('FAIL: there is no Program mode in the toolbar'); await browser.close(); process.exit(1) }
await page.waitForTimeout(1500)

// a program to work on. The panel's own New flow goes through a dialog; this drives the API the
// same way the dialog does, then opens it, because what is being probed is the EDITOR.
const id = 'probe-program'
await page.evaluate(async (pid) => {
  await fetch(`/api/programs/${pid}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'export default 1\n' }) })
}, id)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.seg')].find((x) => x.textContent?.trim() === 'Explore')
  b?.click()
  const p = [...document.querySelectorAll('.seg')].find((x) => x.textContent?.trim() === 'Program')
  p?.click()
})
await page.waitForTimeout(1500)
const row = await page.evaluate((pid) => {
  const r = [...document.querySelectorAll('.row')].find((x) => x.textContent?.includes(pid))
  if (!r) return false
  r.click()
  return true
}, id)
if (!row) fail.push(`the program list does not show ${id}`)

// Monaco has to actually appear
await page.waitForSelector('.monaco-editor', { timeout: 60000 }).catch(() => fail.push('no Monaco editor appeared'))
await page.waitForTimeout(3000)

// The open editor, exposed for probing the way the viewer exposes its knobs. Driving Monaco
// through the DOM — focus, select all, type — is possible and tells you nothing useful when it
// breaks; what is being measured here is the SERVICE behind it, so ask it directly.
const exposed = await page.evaluate(() => !!window.__apexProgram)
if (!exposed) fail.push('the page does not expose the program editor for probing (window.__apexProgram)')

if (exposed) {
  const good = `import { defineGame } from '@apex/program'

export default defineGame({
  setup(api) {
    api.goal('probe')
    api.zone('here', { kind: 'circle', x: 0, y: 0, r: 30 })
    api.hide('street-names')
    api.transport('walk-third')
    api.on('enters', 'here', () => { api.award(7); api.win('found') })
  },
})
`
  const r1 = await page.evaluate(async (src) => {
    const p = window.__apexProgram
    p.setValue(src)
    const diags = await p.check()
    const js = await p.emit()
    const run = await p.dryRun()
    return { diags, emitted: (js ?? '').length, run }
  }, good)
  say('a correct program: errors', r1.diags.length)
  say('  emitted bytes', r1.emitted)
  say('  dry run', { ok: r1.run?.ok, goal: r1.run?.goal, zones: r1.run?.zones, hidden: r1.run?.hidden, transport: r1.run?.transport, outcome: r1.run?.outcome, score: r1.run?.score })
  if (r1.diags.length) fail.push(`a correct program reported ${r1.diags.length} errors: ${r1.diags.map((d) => d.message).join(' | ')}`)
  if (!r1.emitted) fail.push('a correct program emitted nothing — the TypeScript service is not running')
  if (!r1.run?.ok) fail.push(`the dry run failed: ${r1.run?.error}`)
  if (r1.run?.goal !== 'probe') fail.push('the dry run did not see the goal — the program did not actually run')
  if (!r1.run?.zones?.includes('here')) fail.push('the dry run did not see the zone')
  if (!r1.run?.hidden?.includes('street-names')) fail.push('the dry run did not see the hide')
  if (r1.run?.transport !== 'walk-third') fail.push('the dry run did not see the transport swap')
  // the stub player sits at the origin, which is inside the zone, so the win must have fired
  if (r1.run?.outcome !== 'win' || r1.run?.score !== 7) fail.push(`the zone handler did not fire: outcome ${r1.run?.outcome}, score ${r1.run?.score}`)

  const wrong = `import { defineGame } from '@apex/program'

export default defineGame({
  setup(api) {
    api.hide('mnimap')
    api.transport('teleport')
    api.zone('z', { kind: 'blob', x: 0, y: 0 })
    api.award('lots')
  },
})
`
  const r2 = await page.evaluate(async (src) => {
    const p = window.__apexProgram
    p.setValue(src)
    return { diags: await p.check() }
  }, wrong)
  say('a wrong program: errors', r2.diags.length)
  for (const d of r2.diags.slice(0, 4)) say(`  ${d.line}:${d.column}`, d.message.slice(0, 90))
  // four deliberate mistakes, each of a kind the types can catch
  if (r2.diags.length < 4) fail.push(`four deliberate type errors produced only ${r2.diags.length} diagnostics — the declarations are not loaded`)
  const text = r2.diags.map((d) => d.message).join(' ')
  for (const want of ['mnimap', 'teleport']) {
    if (!text.includes(want)) fail.push(`nothing complained about "${want}" — the API's own literal types are not reaching the service`)
  }

  // and the errors do not stop it running: TypeScript emits either way, which is the point of
  // having a dry run as well as a typecheck
  const r3 = await page.evaluate(async () => ({ js: ((await window.__apexProgram.emit()) ?? '').length }))
  say('a wrong program still emits', r3.js > 0)
  if (!r3.js) fail.push('a program with type errors emitted nothing; the dry run would never be reachable')
}

await page.evaluate((pid) => fetch(`/api/programs/${pid}`, { method: 'DELETE' }), id)
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '))
try { await page.screenshot({ path: 'shots/program-editor.png', timeout: 120000 }) } catch { /* the verdict is the measurement */ }
await browser.close()
if (fail.length) { console.log('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1) }
console.log('\nPASS: the editor typechecks against the real API, compiles, and plays what it compiled')
