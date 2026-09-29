// Two editor windows, one MCP connection.
//
// Rich, 2026-09-29: "we need to detect this and allow only a single window to own the mcp access —
// and on other tabs or windows connected to the same back end we offer the option to take the MCP
// connection and disconnect from the other one … we should probably uniquely title each window too
// so the agent can say which one is which."
//
// WHAT THIS IS FOR. Before ownership, `McpBridge.call` served the first page that attached, for as
// long as it stayed. With two editors open an agent's `shell_exec` ran in the OTHER window's shell
// and `editor_state` reported the other window's camera — silently, and with plausible answers.
//
// SO IT OPENS TWO. One window cannot show the bug or the fix: every assertion here is about which
// of two windows answered, and a probe with one window would pass on the old code too.
//
//   node probes/corridor-mcp-owner.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const SVC = process.env.WORLDEDITOR ?? 'http://localhost:8780'
const fail = []
const say = (k, v) => console.log(`${k.padEnd(28)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

const cfg0 = await fetch(`${SVC}/api/agent/mcp/config`).then((r) => r.json()).catch(() => null)
if (!cfg0?.auth?.token) { console.log('\nSKIP: no MCP token from the service'); process.exit(0) }
const token = cfg0.auth.token

const bridge = () => fetch(`${SVC}/api/agent/mcp/config`).then((r) => r.json()).then((c) => c.bridge)
const mcp = (method, params) => fetch(`${SVC}/api/agent/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
}).then((r) => r.json())

// whatever is already attached — somebody's browser — so the counts below are about OUR windows
const before = await bridge()
say('attached before', before.attached)

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const open = async () => {
  const p = await browser.newPage({ viewport: { width: 1100, height: 760 } })
  await p.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 90000 })
  await p.waitForFunction(() => window.__we?.ready(), null, { timeout: 90000 })
  await p.waitForFunction(() => !!window.__mcpown?.me, null, { timeout: 60000 })
  return p
}
const a = await open()
const b = await open()
const nameOf = (p) => p.evaluate(() => ({ me: window.__mcpown.me, owner: window.__mcpown.owner, mine: window.__mcpown.mine }))

/* ---- 1 · two windows, two names, one owner ----
 * CLAIM FIRST, because this probe is not alone on the machine: a browser somebody left open is
 * attached too, and it owned the connection, so neither of these windows did. Asserting "exactly
 * one of my two owns it" without saying which would fail on a correct implementation whenever a
 * third window exists — which is the normal case while somebody is working.
 */
const first = await a.evaluate(() => window.__mcpown.me)
await mcp('tools/call', { name: 'editor_claim', arguments: { page: first.name } })
await a.waitForFunction(() => window.__mcpown?.mine === true, null, { timeout: 15000 }).catch(() => {})
const [oa, ob] = [await nameOf(a), await nameOf(b)]
say('window A', oa)
say('window B', ob)
if (!oa.me?.name || !ob.me?.name) fail.push('a window has no name')
if (oa.me?.name === ob.me?.name) fail.push(`both windows are called "${oa.me?.name}"`)
if (!oa.mine) fail.push('the window that claimed it does not own it')
if (ob.mine) fail.push('both windows think they own it')
const owner = oa.mine ? oa : ob
const other = oa.mine ? ob : oa
if (other.owner?.name !== owner.me?.name) fail.push('the non-owner does not know who owns it')

/* ---- 2 · the tools run in the OWNER, and this is the check the whole thing is for ----
 * MAKE THE WINDOWS TELL EACH OTHER APART FIRST. The first version of this asserted only that
 * `editor_state` did not error, which passes just as happily when the call is served by the wrong
 * window — and it did: reverting `call()` to the old "first attached page wins" left this probe
 * green. So each window is put in a different mode, and the answer has to be the OWNER's mode.
 */
await a.click('.topbar .seg[data-value="assets"]')
await b.click('.topbar .seg[data-value="stage"]')
await a.waitForFunction(() => window.__we?.mode() === 'assets', null, { timeout: 15000 })
await b.waitForFunction(() => window.__we?.mode() === 'stage', null, { timeout: 15000 })

const modeFromMcp = async () => {
  const r = await mcp('tools/call', { name: 'editor_state', arguments: {} })
  const t = r.result?.content?.[0]?.text ?? ''
  if (r.result?.isError) return { error: t.slice(0, 100) }
  try {
    return { mode: JSON.parse(t).mode }
  } catch {
    return { error: `unparseable: ${t.slice(0, 60)}` }
  }
}
const whileOwned = async (page, name, wantMode) => {
  await mcp('tools/call', { name: 'editor_claim', arguments: { page: name } })
  await page.waitForFunction(() => window.__mcpown?.mine === true, null, { timeout: 15000 }).catch(() => {})
  const got = await modeFromMcp()
  say(`with ${name} owning, editor_state`, got)
  if (got.error) fail.push(`editor_state errored while ${name} owned it: ${got.error}`)
  else if (got.mode !== wantMode) fail.push(`${name} owns the connection and is on "${wantMode}", but editor_state answered "${got.mode}" — the call went to another window`)
}
await whileOwned(a, oa.me.name, 'assets')
await whileOwned(b, ob.me.name, 'stage')
// and back, so the first answer cannot have been a coincidence of ordering
await whileOwned(a, oa.me.name, 'assets')

const windows = await mcp('tools/call', { name: 'editor_windows', arguments: {} })
const wtext = windows.result?.content?.[0]?.text ?? ''
say('editor_windows', wtext.replace(/\s+/g, ' ').slice(0, 130))
if (!wtext.includes(owner.me.name)) fail.push('editor_windows does not name the owner')
if (!wtext.includes(other.me.name)) fail.push('editor_windows does not list the other window')

/* ---- 3 · the other window can take it, and the first is told ---- */
const took = await mcp('tools/call', { name: 'editor_claim', arguments: { page: other.me.name } })
say('claimed', (took.result?.content?.[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 90))
if (took.result?.isError) fail.push('editor_claim failed')

// BOTH sides have to reflect it: the taker owns it AND the loser knows it lost it. Asserting only
// the first would pass on an implementation that never tells the window it took it from.
const settled = async (p, want) => p.waitForFunction((w) => window.__mcpown?.mine === w, want, { timeout: 15000 })
  .then(() => true).catch(() => false)
const takerOk = await settled(other === oa ? a : b, true)
const loserOk = await settled(other === oa ? b : a, false)
say('after the claim', { taker_owns: takerOk, loser_released: loserOk })
if (!takerOk) fail.push('the window that claimed it does not think it owns it')
if (!loserOk) fail.push('the window that lost it still thinks it owns it')

const after = await bridge()
say('service agrees', after.owner)
if (after.owner?.name !== other.me.name) fail.push(`the service says ${after.owner?.name} owns it`)

/* ---- 3b · and the window that does NOT own it offers to take it ----
 * The panel is where a person does this; asserting only the MCP tool would leave the button free
 * to be missing, mislabelled, or shown on the window that already owns it.
 */
const panelOf = async (p) => {
  await p.click('.topbar .seg[data-value="agent"]').catch(() => {})
  // WAIT FOR THE PANEL, not for a clock. `load()` fetches the MCP config before it can draw, and a
  // fixed delay measured the first window before that landed and called the empty line a bug.
  await p.waitForFunction(
    () => (document.querySelector('.mcp-section .mcp-live')?.textContent ?? '').trim().length > 0,
    null,
    { timeout: 30000 },
  ).catch(() => {})
  return p.evaluate(() => {
    const root = document.querySelector('.mcp-section') ?? document.body
    const take = [...root.querySelectorAll('button')].find((b) => /Take the connection/i.test(b.textContent ?? ''))
    const live = root.querySelector('.mcp-live')
    return {
      mine: window.__mcpown?.mine ?? null,
      says: live?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      offersTake: !!take,
      takeLabel: take?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    }
  })
}
// `other` lost the connection in step 3; it is the one that should be offering to take it back
const ownerPanel = await panelOf(other === oa ? a : b)
const otherPanel = await panelOf(other === oa ? b : a)
say('owning window says', ownerPanel)
say('other window says', otherPanel)
if (ownerPanel.offersTake) fail.push('the window that OWNS the connection offers to take it')
if (!ownerPanel.says.includes('this window has the MCP connection')) {
  fail.push(`the owning window says "${ownerPanel.says}"`)
}
if (!otherPanel.offersTake) fail.push('the window without the connection offers no way to take it')
else if (!otherPanel.takeLabel?.includes(ownerPanel.says.split(' ')[0])) {
  // the button has to name WHO it is taking from, or it is a button that does something to
  // somebody unnamed
  fail.push(`the take button says "${otherPanel.takeLabel}" and does not name the current owner`)
}

/* ---- 4 · closing the owner hands it on rather than stranding it ---- */
await (other === oa ? a : b).close()
const handed = await (async () => {
  for (let i = 0; i < 30; i++) {
    const s = await bridge()
    if (s.owner && s.owner.name !== other.me.name) return s.owner
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
})()
say('owner after a close', handed ?? 'nobody')
if (!handed) fail.push('closing the owning window left the connection owned by nobody')

await browser.close()
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : '\nPASS: two named windows, one owner, a take that both sides see, and a hand-over on close')
process.exit(fail.length ? 1 : 0)
