// Does the service SURVIVE an MCP session?
//
// Everything else about MCP is tested against `mcp.mjs` directly, which is the right level for
// what a tool does — and it cannot see this class of bug at all, because the bug is in the
// contract between the route and the dispatcher that calls it.
//
// The dispatcher reads its handler's return value: `const r = await api(...); if (r !== undefined)
// return r`. A route that answers the request and then returns nothing therefore falls through to
// the static file server and the 404, both of which write to a response that has already ended —
// and Node does not make that recoverable. It throws ERR_HTTP_HEADERS_SENT out of a tick nobody
// is awaiting and the PROCESS EXITS.
//
// `notifications/initialized` is the second message of every MCP session and it is a notification,
// so it takes the one branch that answered with a bare `return`. The editor died on any client
// that got as far as saying hello.
//
// So this boots the real server and asserts it is still there afterwards. Nothing smaller would
// have caught it: the handler did exactly what it meant to do, and the damage was two frames up.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT = 8000 + Math.floor(Math.random() * 900)
const DATA = mkdtempSync(path.join(tmpdir(), 'we-mcp-'))

const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
  env: { ...process.env, WORLDEDITOR_DATA: DATA, WORLDEDITOR_PORT: String(PORT), WORLDEDITOR_RUNNER: 'local' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (b) => { stderr += b })
after(() => child.kill())

const base = `http://127.0.0.1:${PORT}`
async function up() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return true
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

async function token() {
  const c = await fetch(`${base}/api/agent/mcp/config`).then((r) => r.json())
  return c.auth?.token ?? null
}

/** One JSON-RPC message. Returns the status, since a notification's 202 is the thing in question. */
async function rpc(msg, tok) {
  const r = await fetch(`${base}/api/agent/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: JSON.stringify(msg),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

test('the service survives the message every MCP client sends second', async () => {
  assert.ok(await up(), `the service did not start: ${stderr.slice(-400)}`)
  const tok = await token()

  const hello = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }, tok)
  assert.equal(hello.status, 200)

  // THE MESSAGE THAT KILLED IT: no `id`, so no reply, so the 202 branch.
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, tok)
  assert.equal(note.status, 202, 'a notification is answered with 202 and no body')
  assert.equal(note.body, null, 'a notification has no reply')

  // AND THE POINT OF THE TEST: it is still running. Before the fix the process was already gone,
  // and this call failed to connect rather than returning anything at all.
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tok)
  assert.equal(list.status, 200, `the service died on the notification: ${stderr.slice(-400)}`)
  assert.ok(list.body.result.tools.length > 20, 'the tool list came back')
  assert.equal(child.exitCode, null, `the process exited with ${child.exitCode}: ${stderr.slice(-400)}`)
  assert.ok(!/ERR_HTTP_HEADERS_SENT/.test(stderr), `it wrote to a finished response:\n${stderr.slice(-600)}`)
})

test('a notification with no token is still refused, and does not take the service with it', async () => {
  assert.ok(await up())
  const bad = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'aat_wrong')
  assert.equal(bad.status, 401)
  assert.equal(child.exitCode, null)
})
