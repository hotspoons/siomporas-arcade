// The editor as an MCP server, seen from a browser — which is the one thing the lane that built it
// could not check, because `main` did not build.
//
// TWO HALVES, and only the second needs a page. The 61 server-side tools answer with no browser
// open and are covered by `tools/worldeditor/mcpbridge.test.mjs`. What is unverified is: does the
// pane render, does a page attach, and does a tool that can only run in the page come back with a
// real answer rather than the "no editor connected" error that a detached bridge gives.
//
// So this drives a real editor page and then calls MCP from OUTSIDE it, which is the only way to
// tell those two apart: a probe that asked the page directly would pass with the bridge unplugged.
//
//   node probes/corridor-mcp.mjs
import { chromium } from 'playwright'

const PORT = process.env.PORT ?? '5185'
const SVC = process.env.WORLDEDITOR ?? 'http://localhost:8780'
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.split('\n')[0]))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(26)} ${typeof v === 'object' ? JSON.stringify(v) : v}`)

const cfg = await fetch(`${SVC}/api/agent/mcp/config`).then((r) => r.json())
const token = cfg.auth?.token
if (!token) fail.push('the service minted no token')

/** One MCP call, from outside the browser entirely. */
async function mcp(method, params, auth = token) {
  const r = await fetch(`${SVC}/api/agent/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/* ---- 1 · the token is required, and the two mistakes are different ---- */
const noAuth = await mcp('tools/list', {}, null)
const badAuth = await mcp('tools/list', {}, 'aat_not_the_token')
say('no header / wrong token', [noAuth.status, badAuth.status])
if (noAuth.status !== 401) fail.push(`an unauthenticated call got ${noAuth.status}, not 401`)
if (badAuth.status !== 401) fail.push(`a wrong token got ${badAuth.status}, not 401`)
const m1 = JSON.stringify(noAuth.body), m2 = JSON.stringify(badAuth.body)
if (m1 === m2) fail.push('"no token" and "wrong token" say the same thing — they are different mistakes')

/* ---- 2 · the pane, in the editor, which nobody has ever seen ---- */
await page.goto(`http://localhost:${PORT}/world.html`, { waitUntil: 'networkidle', timeout: 90000 })
await page.waitForFunction(() => window.__we?.ready(), null, { timeout: 90000 })
await page.click('.topbar .seg[data-value="agent"]')
await page.waitForTimeout(3000)
const pane = await page.evaluate(() => {
  const root = document.querySelector('.mcp, [class*="mcp"]')
  if (!root) return null
  const text = root.textContent
  return {
    url: /\/api\/agent\/mcp/.test(text),
    token: /aat_/.test(text),
    config: /mcpServers/.test(text),
    status: (root.querySelector('.mcp-status, .dot')?.parentElement?.textContent ?? '').trim().slice(0, 40),
    saidNoService: /did not answer/i.test(text),
  }
})
say('the MCP pane', pane ?? 'not rendered')
if (!pane) fail.push('the MCP pane does not render in the Agent tab')
else {
  if (pane.saidNoService) fail.push('the pane says the service did not answer about MCP')
  if (!pane.url) fail.push('the pane does not show the URL to point a client at')
  if (!pane.token) fail.push('the pane does not show a token')
  if (!pane.config) fail.push('the pane does not show an mcpServers block to paste')
}

/* ---- 3 · the page attached, and the service can see it ---- */
const attached = await (async () => {
  for (let i = 0; i < 30; i++) {
    const c = await fetch(`${SVC}/api/agent/mcp/config`).then((r) => r.json()).catch(() => null)
    if (c?.bridge?.attached > 0) return c.bridge
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
})()
say('bridge', attached ?? 'nothing attached')
if (!attached) fail.push('the editor page never attached to the bridge')

/* ---- 4 · the tool count grows when a page is there ---- */
const tools = await mcp('tools/list', {})
const names = tools.body?.result?.tools?.map((t) => t.name) ?? []
say('tools', names.length)
if (names.length < 60) fail.push(`only ${names.length} tools`)
for (const want of ['world_list', 'program_list', 'asset_list', 'shell_exec', 'code_check']) {
  if (!names.includes(want)) fail.push(`no ${want} tool`)
}

/* ---- 5 · a SERVER tool, answered with real data ---- */
const worlds = await mcp('tools/call', { name: 'world_list', arguments: {} })
const worldText = worlds.body?.result?.content?.[0]?.text ?? ''
say('world_list', worldText.slice(0, 70))
if (!/crofton|arrowhead|slug/i.test(worldText)) fail.push('world_list did not answer with real worlds')

/* ---- 6 · a PAGE tool, which is the untested path ---- */
// THE SHELL HAS TO HAVE BEEN STARTED. It is a wasm machine that boots when the Shell tab is first
// opened, and until then `shell_exec` answers with a real instruction rather than a wrong result —
// which is correct behaviour and worth seeing, so it is checked on the way past.
// ONLY WHEN THIS PAGE IS THE ONLY ONE. The bridge keeps whatever is attached, so a browser left
// open from an earlier run — or Rich's own editor — already has a booted shell, and asserting the
// cold error unconditionally made this probe fail depending on what else was on the machine. A
// check whose result depends on the neighbours is not a check; it is asserted when it is
// answerable and reported as skipped when it is not.
const cold = await mcp('tools/call', { name: 'shell_exec', arguments: { command: 'echo cold' } })
const coldText = cold.body?.result?.content?.[0]?.text ?? ''
const ours = attached?.pages?.length === 1
say('before the shell exists', ours ? coldText.replace(/\s+/g, ' ').slice(0, 70) : '(skipped — another editor page is attached)')
if (ours) {
  if (!cold.body?.result?.isError) fail.push('a shell tool answered before any shell had started')
  else if (!/shell/i.test(coldText)) fail.push('the cold error does not say what to do about it')
}

/*
 * TAKE THE CONNECTION FIRST. Browser tools run in the window that OWNS it, and a browser somebody
 * left open may own it — which is why this check used to be skipped. Claiming is one call now, so
 * the round trip can be tested for real instead of reported as untestable.
 */
const mine = await page.evaluate(() => window.__mcpown?.me?.name ?? null)
if (mine) {
  await mcp('tools/call', { name: 'editor_claim', arguments: { page: mine } })
  await page.waitForFunction(() => window.__mcpown?.mine === true, null, { timeout: 15000 }).catch(() => {})
}
say('this page owns it', await page.evaluate(() => !!window.__mcpown?.mine))

await page.click('.topbar .seg[data-value="shell"]')
await page.waitForFunction(() => !!window.__we && document.querySelector('[data-pane="shell"]')?.textContent?.length > 20, null, { timeout: 60000 }).catch(() => {})
// the machine takes a while to come up; wait for the tool to stop refusing rather than for a clock
for (let i = 0; i < 40; i++) {
  const r = await mcp('tools/call', { name: 'shell_exec', arguments: { command: 'true' } })
  if (!r.body?.result?.isError) break
  await new Promise((r) => setTimeout(r, 2000))
}

// THE WHOLE POINT: this runs in the browser, over the socket, and comes back through MCP. With the
// bridge unplugged it is an error rather than a wrong answer, so a mutation here is visible.
const shell = await mcp('tools/call', { name: 'shell_exec', arguments: { command: 'echo mcp-probe-42' } })
const shellText = shell.body?.result?.content?.[0]?.text ?? JSON.stringify(shell.body).slice(0, 200)
say('shell_exec in the page', shellText.replace(/\s+/g, ' ').slice(0, 90))
/*
 * WHOSE PAGE RAN IT. The bridge picks the FIRST attached page that offers the tool
 * (`[...this.pages].find(...)` in mcpbridge.mjs), so when more than one editor is attached — this
 * probe's, plus a browser somebody left open — every browser tool goes to the OTHER one, whatever
 * this probe does to its own page. That is a real routing question and not this probe's to answer,
 * so it says which case it is in rather than blaming the code for the neighbours.
 */
const nowAttached = await fetch(`${SVC}/api/agent/mcp/config`).then((r) => r.json()).then((c) => c.bridge?.attached ?? 0).catch(() => 0)
let skippedRoundTrip = false
if (shell.body?.result?.isError && nowAttached > 1) {
  skippedRoundTrip = true
  say('shell round trip', `(skipped — ${nowAttached} pages attached and the bridge serves the first)`)
} else if (shell.body?.result?.isError) {
  fail.push(`shell_exec came back as an error: ${shellText.slice(0, 120)}`)
} else if (!/mcp-probe-42/.test(shellText)) {
  fail.push(`shell_exec did not run in the page — got "${shellText.slice(0, 80)}"`)
}

if (errs.length) { say('page errors', [...new Set(errs)].slice(0, 3)); fail.push(`${errs.length} page errors`) }
// SAY WHAT WAS ACTUALLY TESTED. A verdict claiming "a browser tool answered" after skipping that
// very check is how a probe becomes something nobody can act on.
const verdict = skippedRoundTrip
  ? 'PASS: the pane renders and a page attaches — the browser-tool round trip went untested, see above'
  : 'PASS: the pane renders, a page attaches, and a browser-only tool answers through MCP'
console.log(fail.length ? `\nFAIL:\n  ${fail.join('\n  ')}` : `\n${verdict}`)
await browser.close()
process.exit(fail.length ? 1 : 0)
