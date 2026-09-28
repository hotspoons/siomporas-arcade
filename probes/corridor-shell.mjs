// Does the in-editor shell run, and does a write in it reach the document?
//
// Everything about this is only true in a browser: the worker boots a wasm interpreter, the
// coreutils are a bundled library, the projection is an HTTP round trip, and the network seal is
// a property of the worker's globals. So the probe drives the real page and types real commands.
//
// The four things it exists for, each of which fails silently:
//
//   the worker      a module worker whose vendor import 404s never posts `ready`, and the panel
//                   simply sits at "starting the shell…" for ever
//   the projection  a wrong path maps to no endpoint, so an edit is accepted, kept in memory, and
//                   quietly not saved
//   the write-back  the opposite: a save that lands on the WRONG document, which does not fail
//   the seal        the worker must have no network. Python's `js` module reaches the worker's
//                   globals, so a script could otherwise call the editor's API with the page's own
//                   credentials — and on a dev box that is admin.
//
//   node probes/corridor-shell.mjs
import { chromium } from 'playwright'

const url = process.env.PROBE_URL ?? 'http://localhost:5185/world.html'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 820 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
const bad = []
page.on('response', (r) => { if (r.status() >= 400 && /agent\//.test(r.url())) bad.push(`${r.status()} ${r.url()}`) })
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })

const fail = []
const say = (k, v) => console.log(`${k.padEnd(32)} ${typeof v === 'object' ? JSON.stringify(v) : String(v).slice(0, 180)}`)

// a program to find in the projection, made through the API the way the editor does
const ID = 'probe-shell'
await page.evaluate(async (id) => {
  await fetch(`/api/programs/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'export default 1\n' }) })
}, ID)

// into the Shell mode
await page.waitForSelector('.seg', { timeout: 30000 })
const opened = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.seg')].find((x) => x.textContent?.trim() === 'Shell')
  if (!b) return false
  b.click()
  return true
})
if (!opened) { console.log('FAIL: there is no Shell mode in the toolbar'); await browser.close(); process.exit(1) }

// the machine has to say `ready`; a vendor 404 means it never will
await page.waitForFunction(() => {
  const out = document.querySelector('#code .term-out')
  return !!out && /documents, in a shell/.test(out.textContent ?? '')
}, null, { timeout: 90000 }).catch(() => fail.push('the shell never became ready — the worker or its vendor bundle did not load'))

/**
 * Type a command at the prompt the way a person does, and read what came back.
 *
 * `until` is what stops this being a probe that cannot fail: a fixed wait on a command that takes
 * longer than it — Pyodide's first load is fifteen megabytes — returns the shell's own "loading…"
 * line, every assertion about the output passes vacuously, and nothing says so.
 */
async function run(cmd, { until = null, timeout = 60000 } = {}) {
  const before = await page.evaluate(() => document.querySelector('#code .term-out')?.textContent?.length ?? 0)
  await page.evaluate((c) => {
    const i = document.querySelector('#code .term-input')
    i.value = c
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }, cmd)
  const done = until
    ? page.waitForFunction(({ n, re }) => new RegExp(re).test((document.querySelector('#code .term-out')?.textContent ?? '').slice(n)), { n: before, re: until }, { timeout })
    : page.waitForFunction(({ n, len }) => (document.querySelector('#code .term-out')?.textContent?.length ?? 0) > n + len, { n: before, len: cmd.length + 4 }, { timeout })
  let timedOut = false
  await done.catch(() => { timedOut = true })
  await page.waitForTimeout(400)
  const text = await page.evaluate((n) => (document.querySelector('#code .term-out')?.textContent ?? '').slice(n), before)
  if (timedOut && until) fail.push(`\`${cmd}\` never produced /${until}/ — got ${JSON.stringify(text.slice(0, 160))}`)
  return text
}

say('pwd', await run('pwd'))
const ls = await run('ls')
say('ls', ls.replace(/\s+/g, ' '))
for (const want of ['README.md', 'programs', 'worlds']) {
  if (!ls.includes(want)) fail.push(`\`ls\` does not show ${want} — the projection did not seed`)
}

const cat = await run(`cat programs/${ID}.ts`)
say('cat a projected program', cat.replace(/\s+/g, ' '))
if (!cat.includes('export default 1')) fail.push('a projected program does not read back')

// coreutils, over the real documents
const wc = await run('ls worlds/ | wc -l')
say('ls worlds | wc -l', wc.replace(/\s+/g, ' '))
if (!/\d/.test(wc)) fail.push('a pipeline through wc produced no number — the coreutils are not there')

// A WRITE REACHES THE DOCUMENT.
const written = await run(`printf 'export default 2\\n' > programs/${ID}.ts && echo done`)
say('write a program', written.replace(/\s+/g, ' '))
await page.waitForTimeout(1200)
const saved = await page.evaluate(async (id) => (await (await fetch(`/api/programs/${id}`)).json()).source, ID)
say('the service now holds', saved.trim())
if (!saved.includes('export default 2')) fail.push(`a write in the shell did not reach the document (service has ${JSON.stringify(saved)})`)
const savedLine = await page.evaluate(() => document.querySelector('#code .term-out')?.textContent?.match(/saved the program [\w-]+/)?.[0] ?? null)
say('it said so', savedLine)
if (!savedLine) fail.push('the shell saved a document without saying which')

// a scratch file goes nowhere, and says nothing
const scratch = await run("echo hello > out/notes.md && cat out/notes.md")
say('out/ is yours', scratch.replace(/\s+/g, ' '))
if (!scratch.includes('hello')) fail.push('a scratch file in out/ did not read back')
const claimed = await page.evaluate(() => (document.querySelector('#code .term-out')?.textContent ?? '').includes('saved out/notes.md'))
if (claimed) fail.push('the shell claimed to save a file that maps to no document')

// THE SEAL. The worker must have no way to reach the editor's API.
const CMD = "js -e \"try { fetch('/api/worlds'); console.log('REACHED THE API') } catch (e) { console.log('no fetch here') }\""
const sealed = await run(CMD)
// the echoed command line contains the string it is looking for, so only what came BACK counts —
// checking the whole buffer passes whatever the sandbox does, which is a probe that cannot fail
const reply = sealed.slice(sealed.indexOf(CMD) + CMD.length)
say('js reaching for the API', reply.replace(/\s+/g, ' '))
if (reply.includes('REACHED THE API')) fail.push('the sandboxed js interpreter reached the editor API — the seal is not holding')
if (!reply.includes('no fetch here')) fail.push(`the sandbox did not answer at all: ${JSON.stringify(reply.slice(0, 120))}`)

// AND PYTHON, which is the one that matters: its `js` module reaches the worker's own globals, so
// a script could otherwise open a socket to the editor's API with the page's own credentials — and
// on a dev box the loopback authenticator makes that admin.
//
// IT HAS TO TRY, not look. The seal defines these properties as `undefined` rather than deleting
// them, so `hasattr(js, 'WebSocket')` is True and means nothing: the first version of this check
// reported a wide open worker about a worker that is shut. What matters is whether a script can
// USE one, so the script constructs and calls.
//
// Fifteen megabytes of Pyodide on the first run, so this waits for the answer rather than a clock.
const SEAL = [
  'import js',
  "have = [n for n in ('WebSocket','XMLHttpRequest','EventSource','WebTransport') if getattr(js, n, None) is not None]",
  "net = 'blocked'",
  'try:',
  "    await js.fetch('/api/worlds')",
  "    net = 'REACHED THE API'",
  'except Exception as e:',
  "    net = 'blocked'",
  "print('SEAL', ','.join(have) or 'none', net)",
]
const write = `printf '%s\\n' ${SEAL.map((l) => `'${l.replace(/'/g, `'\\''`)}'`).join(' ')} > out/seal.py`
await run(write)
const py = await run('python out/seal.py', { until: 'SEAL \\S+ \\S+', timeout: 240000 })
const answer = /SEAL (\S+) (\S+)/.exec(py)
say('python trying the doors', answer ? answer[0] : '(no answer)')
if (!answer) fail.push('python never answered whether the worker can reach the network')
else {
  if (answer[1] !== 'none') fail.push(`the worker still has usable network objects on it: ${answer[1]}`)
  if (answer[2] !== 'blocked') fail.push('python reached the editor API from inside the sandbox — the seal is not holding')
}

await page.evaluate((id) => fetch(`/api/programs/${id}`, { method: 'DELETE' }), ID)
if (bad.length) fail.push('the shell asked for something that 404d: ' + bad.slice(0, 3).join(', '))
if (errs.length) fail.push('page errors: ' + errs.slice(0, 3).join(' | '))
try { await page.screenshot({ path: 'shots/shell.png', timeout: 120000 }) } catch { /* the verdict is the measurement */ }
await browser.close()
if (fail.length) { console.log('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1) }
console.log('\nPASS: the shell runs, the documents are in it, a write reaches the service, and the sandbox has no network')
