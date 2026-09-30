// The shell: eight places to be, four stages inside one of them, and a menu that is about the
// installation rather than about everything.
//
// Rich, 2026-09-29: "Explore, define, and bake need to be collapsed into a single item with a
// multistage wizard form or something… Index doesn't make any sense… Lots of times clicking
// things will highlight text in menus, and the hamburger menu and main menu need a rethink for
// what goes where. 'drive it' won't make any sense from that menu, new world is already in that
// explore tab, and we need a settings tab."
//
// WHAT IS ASSERTED AND WHY IT IS ASSERTED THAT WAY. Every check here is about a thing that used
// to be true and must not come back — a mode that was removed, a drawer row that led nowhere, a
// label that selected as text. Existence checks would pass on all of the old behaviour, so these
// check position, state and effect instead.
//
//   node probes/corridor-chrome.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForFunction(() => window.__we?.ready(), null, { timeout: 90000 })

/* ---- 1 · the bar is eight surfaces, and the four are not among them ---- */
const bar = await page.$$eval('.topbar .seg', (b) => b.map((x) => x.dataset.value))
say('the bar', bar)
if (bar.length !== 8) fail.push(`${bar.length} items in the bar, not 8`)
// …and the agent (2026-09-30): it is Settings → Agent, not a place you build a world
for (const gone of ['explore', 'index', 'define', 'bake', 'agent']) {
  if (bar.includes(gone)) fail.push(`${gone} is still a top-level mode`)
}
for (const want of ['world', 'place', 'stage', 'assets', 'program', 'shell', 'splats', 'deploy']) {
  if (!bar.includes(want)) fail.push(`no ${want} in the bar`)
}

/* ---- 2 · the stages, and bouncing between them ---- */
const steps = await page.$$eval('#steps .tab', (b) => b.map((x) => x.textContent.trim()))
say('the stages', steps)
if (steps.length !== 4) fail.push(`${steps.length} stages, not 4`)
if (steps.some((s) => /Index/.test(s))) fail.push('"Index" is still a label')

// bouncing has to actually change the panel, not just the strip
const bounced = []
for (const name of ['Places', 'Define', 'Bake', 'Explore']) {
  await page.click(`#steps .tab:has-text("${name}")`)
  await page.waitForTimeout(700)
  bounced.push({
    on: await page.$eval('#steps .tab.on', (b) => b.textContent.trim()),
    step: await page.evaluate(() => window.__we.step()),
    panel: await page.$eval('#panel', (n) => n.textContent.trim().slice(0, 30)),
  })
}
say('bounced', bounced.map((b) => `${b.step}:${b.panel.slice(0, 14)}`))
if (new Set(bounced.map((b) => b.panel)).size < 3) fail.push('the stages show the same panel')
for (const b of bounced) if (!b.on.includes(b.step === 'places' ? 'Places' : b.step[0].toUpperCase() + b.step.slice(1))) {
  fail.push(`the strip says ${b.on} while the page is on ${b.step}`)
}

/* ---- 3 · the stage travels in the URL, and so does a link written before it existed ---- */
await page.click('#steps .tab:has-text("Bake")')
await page.waitForTimeout(400)
const url = await page.evaluate(() => location.search)
say('the url carries it', url)
if (!/mode=world/.test(url) || !/step=bake/.test(url)) fail.push(`the url is ${url}`)

await page.goto(`http://localhost:${PORT}/world.html?mode=define`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForFunction(() => window.__we?.ready(), null, { timeout: 90000 })
const legacy = await page.evaluate(() => ({ mode: window.__we.mode(), step: window.__we.step() }))
say('an old ?mode=define link', legacy)
if (legacy.mode !== 'world' || legacy.step !== 'define') fail.push(`an old link landed on ${JSON.stringify(legacy)}`)

/* ---- 4 · the drawer is the installation, not everything ---- */
await page.click('.topbar button[title="menu"]')
await page.waitForTimeout(400)
const rows = await page.$$eval('.drawer .drawer-item', (b) => b.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))
say('the drawer', rows)
if (!rows.some((r) => /Settings/.test(r))) fail.push('no Settings in the drawer')
if (rows.some((r) => /Drive it/.test(r))) fail.push('"Drive it" is still in the drawer, where it cannot know if there is anything to drive')
if (rows.some((r) => /New world/.test(r))) fail.push('"New world" is still in the drawer as well as in Define')

/* ---- 5 · Settings has the four things, and Git is one of them ---- */
await page.click('.drawer .drawer-item:has-text("Settings")')
await page.waitForTimeout(900)
const tabs = await page.$$eval('.dialog .tab-strip .tab', (b) => b.map((x) => x.textContent.trim()))
say('settings tabs', tabs)
for (const want of ['Git and LFS', 'Agent', 'Appearance', 'Services']) {
  if (!tabs.some((t) => t.includes(want))) fail.push(`Settings has no ${want} tab`)
}
// Services was a nine-second toast; it has to be readable twice
/* ---- 4b · the agent lives in Settings now: its terminal and its sidebar, not a hint ---- */
await page.click('.dialog .tab:has-text("Agent")')
await page.waitForTimeout(800)
const agent = await page.evaluate(() => {
  const panel = document.querySelector('.dialog .tab-panel:not([hidden])')
  const pane = panel?.querySelector('.agent-pane')
  const side = panel?.querySelector('.agent-side')
  const box = (e) => { const r = e?.getBoundingClientRect(); return r ? Math.round(r.width) : 0 }
  return { pane: box(pane), side: box(side), term: !!pane?.querySelector('.term-input'), sideRows: side?.childElementCount ?? 0, hint: panel?.textContent.includes('Bar → Agent') ?? false }
})
say('the agent tab', agent)
if (!agent.term) fail.push('the Agent tab has no terminal in it')
if (agent.pane < 200 || agent.side < 200) fail.push(`the agent surface is not laid out (pane ${agent.pane}px, side ${agent.side}px)`)
if (!agent.sideRows) fail.push('the agent sidebar is empty')
if (agent.hint) fail.push('the Agent tab is still the placeholder hint')
if (await page.evaluate(() => window.__we.mode()) === 'agent') fail.push('opening the Agent tab changed the mode')
await page.click('.dialog .tab:has-text("Services")')
// wait for the READOUTS, not for the placeholder to go: the panel starts as one <p> and becomes
// six rows, and a text test on it passes the instant the fetch rejects and leaves it empty
await page.waitForFunction(
  () => document.querySelectorAll('.dialog .tab-panel:not([hidden]) .readout').length >= 6,
  null,
  { timeout: 30000 },
).catch(() => {})
// the label, off its own element — `readout` puts label and value in adjacent spans with no text
// between them, so splitting the row's text gives you "data/workspaces/apex-conduit/…"
const services = await page.$$eval('.dialog .tab-panel:not([hidden]) .readout .field-label', (n) => n.map((x) => x.textContent.trim()))
say('services readouts', services)
for (const want of ['data', 'runner', 'overpass', 'assetsvc']) {
  if (!services.includes(want)) fail.push(`Services does not say what ${want} is`)
}
await page.keyboard.press('Escape')
await page.waitForTimeout(400)

/* ---- 6 · chrome does not select as text, and readouts still do ---- */
// THE MECHANISM, not the rule: double-click a tab and ask the page what got selected.
const selection = await page.evaluate(() => {
  const pick = (el) => {
    getSelection().removeAllRanges()
    const r = document.createRange()
    r.selectNodeContents(el)
    getSelection().addRange(r)
    // what a real double-click would leave behind: the browser refuses to select unselectable text
    return getSelection().toString().trim()
  }
  const tab = document.querySelector('#steps .tab')
  const seg = document.querySelector('.topbar .seg span')
  return { tab: pick(tab), seg: pick(seg) }
})
say('selected from chrome', selection)
// `user-select: none` makes the selection come back empty
if (selection.tab) fail.push(`a stage label still selects as text ("${selection.tab}")`)
if (selection.seg) fail.push(`a bar label still selects as text ("${selection.seg}")`)

/* ---- 7 · Drive it is on the world, and knows whether there is one ---- */
const drive = await page.evaluate(() => {
  const b = [...document.querySelectorAll('.topbar-site button')].find((x) => /drive|not baked|no world/i.test(x.title))
  return b ? { title: b.title, disabled: b.disabled } : null
})
say('drive it', drive)
if (!drive) fail.push('there is no way to drive the selected world from the bar')
else if (!drive.disabled && !/^drive /.test(drive.title)) fail.push(`"${drive.title}" is enabled but does not name a baked world`)

if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: eight surfaces, four stages that bounce, a settings menu, and chrome that does not select')
await browser.close()
process.exit(fail.length ? 1 : 0)
