// Does the agent relay carry a session, and does the token stay on the service?
//
// The relay exists for one reason: a browser's WebSocket cannot send headers, and the platform's
// tunnel needs the PAT in `Authorization` AND a one-time token in `?t=`. So the thing to prove is
// that the bytes go through with the headers a page could not have sent, and that nothing the page
// can see ever contains the token.
//
// It runs against a FAKE platform — an https-shaped stand-in for the real one, so the contract is
// exercised without a cluster. What the fake checks is what the real one checks: patapsco-remote's
// own notes record that OTP-as-bearer is a 401 "insufficient permissions" and a PAT bearer with no
// `?t=` is a 401 "missing otp", and both look like a bad token from outside.
//
//   node probes/worldeditor-agent.mjs
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'

const TOKEN = 'pat_this_must_never_leave_the_service'
const root = mkdtempSync(path.join(tmpdir(), 'agent-probe-'))
const fail = []
const say = (k, v) => console.log(`${k.padEnd(34)} ${typeof v === 'object' ? JSON.stringify(v) : String(v).slice(0, 140)}`)

/* ---- a stand-in for the platform ---------------------------------------------------------- */
const seen = { otpBody: null, otpAuth: null, wsAuth: null, wsUrl: null, mirror: null }
let otpCount = 0
const platform = createServer((req, res) => {
  if (req.url === '/api/v1/remote-dev/agents/deployments') {
    seen.listAuth = req.headers.authorization
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ deployments: [{ name: 'claude', namespace: 'agents', phase: 'Running' }] }))
    return
  }
  if (req.url === '/api/v1/remote-dev/tunnels/otp') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      seen.otpBody = body
      seen.otpAuth = req.headers.authorization
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ token: `otp-${++otpCount}`, expires_in: 60 }))
    })
    return
  }
  res.statusCode = 404
  res.end('{}')
})
// the agent at the far end of the tunnel: it echoes a JSON-RPC response, which is all the relay
// has to carry for this to be a working session
const upstreamWs = new WebSocketServer({ server: platform, path: '/api/v1/remote-dev/tunnels/connect' })
upstreamWs.on('connection', (ws, req) => {
  seen.wsAuth = req.headers.authorization
  seen.mirror = req.headers['x-patapscoai-token']
  seen.wsUrl = req.url
  ws.on('message', (data) => {
    const m = JSON.parse(String(data))
    if (m.method === 'initialize') ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } }))
    if (m.method === 'session/new') ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess-probe' } }))
  })
})
await new Promise((r) => platform.listen(0, r))
// the client requires https and the fake speaks http, so the probe proves the check works and then
// writes the credential file directly rather than weakening it
const PLATFORM_HTTP = `http://localhost:${platform.address().port}`

/* ---- the service -------------------------------------------------------------------------- */
const PORT = 8792
const service = spawn('node', ['tools/worldeditor/server.mjs'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, WORLDEDITOR_DATA: root, WORLDEDITOR_PORT: String(PORT), WORLDEDITOR_RUNNER: 'local' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const logs = []
service.stdout.on('data', (d) => logs.push(String(d)))
service.stderr.on('data', (d) => logs.push(String(d)))
const api = async (p, init) => {
  const r = await fetch(`http://localhost:${PORT}/api/agent${p}`, { headers: { 'content-type': 'application/json' }, ...init })
  return { status: r.status, text: await r.text() }
}

try {
  for (let i = 0; i < 100; i += 1) {
    try { await fetch(`http://localhost:${PORT}/api/agent`); break } catch { await new Promise((r) => setTimeout(r, 100)) }
  }

  const before = await api('')
  say('no credential yet', before.text.trim())
  if (JSON.parse(before.text).set !== false) fail.push('a fresh service claims to have a platform credential')

  // the https check is real, and the probe proves it before going round it
  const plain = await api('/credential', { method: 'PUT', body: JSON.stringify({ base: PLATFORM_HTTP, token: TOKEN }) })
  say('an http platform URL', `${plain.status} ${JSON.parse(plain.text).error ?? ''}`)
  if (plain.status !== 400) fail.push('an http:// platform URL was accepted')

  // store it the way the service stores it, with the http base the fake speaks
  const { writeFileSync, chmodSync } = await import('node:fs')
  const credFile = path.join(root, '.platform-credential')
  writeFileSync(credFile, JSON.stringify({ base: PLATFORM_HTTP, token: TOKEN, user: 'rich' }), { mode: 0o600 })
  chmodSync(credFile, 0o600)

  const info = await api('')
  say('what the page is told', info.text.trim())
  if (info.text.includes(TOKEN)) fail.push('GET /api/agent returned the token')
  if (JSON.parse(info.text).set !== true) fail.push('the stored credential is not reported')

  const list = await api('/agents')
  say('the agent list', list.text.trim())
  if (list.text.includes(TOKEN)) fail.push('the agent list returned the token')
  if (!list.text.includes('claude')) fail.push(`the agent list did not come through: ${list.text.slice(0, 120)}`)
  if (seen.listAuth !== `Bearer ${TOKEN}`) fail.push('the service did not send the PAT to the platform')

  /* ---- the tunnel, the way a page opens it ---- */
  const ws = new WebSocket(`ws://localhost:${PORT}/api/agent/tunnel?kind=agent&namespace=agents&name=claude&class=pty`)
  const replies = []
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
    ws.on('close', (c, r) => reject(new Error(`closed ${c} ${r}`)))
    setTimeout(() => reject(new Error('the relay never opened')), 10000)
  })
  ws.on('message', (d) => replies.push(JSON.parse(String(d))))
  // sent IMMEDIATELY, before the upstream handshake can have finished — the first frame of every
  // real session arrives in exactly this window, and a relay that does not buffer drops it
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }))
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/workspace' } }))
  await new Promise((r) => setTimeout(r, 1500))

  say('what came back', JSON.stringify(replies))
  if (replies.length !== 2) fail.push(`the relay carried ${replies.length} of 2 replies — the first frame was dropped`)
  if (replies[1]?.result?.sessionId !== 'sess-probe') fail.push('the session was not opened through the relay')

  say('the OTP request', seen.otpBody)
  if (JSON.parse(seen.otpBody ?? '{}').class !== 'pty') fail.push('the tunnel class did not reach the platform')
  if (seen.otpAuth !== `Bearer ${TOKEN}`) fail.push('the OTP was minted without the PAT')

  say('the upstream headers', { auth: seen.wsAuth?.replace(TOKEN, '<the PAT>'), mirror: seen.mirror?.replace(TOKEN, '<the PAT>') })
  say('the upstream URL', seen.wsUrl)
  // the contract: PAT in the header, one-time token in the query, and NOT the other way round
  if (seen.wsAuth !== `Bearer ${TOKEN}`) fail.push('the upstream socket had no PAT — a page could not have sent this, which is the whole point')
  if (seen.mirror !== TOKEN) fail.push('the X-PatapscoAI-Token mirror was not sent; oauth2-proxy strips Authorization')
  if (!/[?&]t=otp-/.test(seen.wsUrl ?? '')) fail.push('the one-time token was not in the query')
  if ((seen.wsAuth ?? '').includes('otp-')) fail.push('the OTP was sent as the bearer — the platform answers that with "insufficient permissions"')

  ws.close()

  // A SECOND TUNNEL MINTS ITS OWN, because they are single use.
  //
  // Waiting for the MINT and not for the socket to open: the browser's end opens as soon as the
  // upgrade completes, which is before the relay has asked the platform for anything. Checking the
  // count at that moment reads 1 every time and the probe fails whatever the relay does.
  const ws2 = new WebSocket(`ws://localhost:${PORT}/api/agent/tunnel?kind=agent&namespace=agents&name=claude&class=pty`)
  const deadline = Date.now() + 10_000
  while (otpCount < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  say('tokens minted', otpCount)
  if (otpCount < 2) fail.push('the second tunnel reused the first one-time token')
  ws2.close()

  // a tunnel to nothing says why rather than hanging
  const ws3 = new WebSocket(`ws://localhost:${PORT}/api/agent/tunnel?kind=agent&namespace=agents`)
  const why = await new Promise((r) => {
    ws3.on('close', (code, reason) => r(`${code} ${reason}`))
    setTimeout(() => r('(never closed)'), 5000)
  })
  say('a tunnel naming no agent', why)
  if (!String(why).includes('no agent named')) fail.push(`a tunnel with no agent should be refused with a reason, got ${why}`)
} catch (e) {
  fail.push(`threw: ${e.message}`)
} finally {
  service.kill()
  platform.close()
  upstreamWs.close()
}

if (logs.join('').includes(TOKEN)) fail.push('the service logged the token')
if (fail.length) { console.log('\nFAIL:\n  ' + fail.join('\n  ')); process.exit(1) }
console.log('\nPASS: the relay carries a session with headers a page cannot send, and the token never leaves the service')
