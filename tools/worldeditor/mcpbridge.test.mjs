// The bridge, end to end, over a real socket.
//
// WHAT THIS HAS TO PROVE, and each of these is a way the whole design fails quietly:
//
//   a page can register tools and they appear in tools/list
//   a call reaches the page and its answer comes back
//   a page that throws produces a tool error, not a dead request
//   a tool nobody offers is refused with the reason, not "no such tool"
//   a page that disconnects mid-call fails that call instead of hanging until timeout
//   the token is actually enforced on the socket
//
// It uses a real WebSocket against a real http server rather than calling methods on McpBridge,
// because the parts most likely to break are the upgrade handling and the auth on it — neither of
// which a direct method call touches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocket } from 'ws'
import { McpBridge } from './mcpbridge.mjs'

/** A server with the bridge attached, on a port the OS picks. */
async function harness({ auth = null } = {}) {
  const server = http.createServer((_req, res) => res.end('ok'))
  const bridge = new McpBridge({ log: { log() {} } })
  bridge.attach(server, { auth })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    bridge,
    port,
    url: `ws://127.0.0.1:${port}/api/agent/bridge`,
    async close() {
      bridge.close()
      await new Promise((r) => server.close(r))
    },
  }
}

/** A fake editor page: registers a manifest, answers calls from a table. */
function fakePage(url, tools, handlers, { label = 'test-page' } = {}) {
  const ws = new WebSocket(url)
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'register', label, tools }))
      resolve()
    })
    ws.on('error', reject)
  })
  ws.on('message', async (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.type !== 'call') return
    try {
      const result = await handlers[msg.name](msg.args)
      ws.send(JSON.stringify({ type: 'result', id: msg.id, result }))
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', id: msg.id, error: String(e.message) }))
    }
  })
  return { ws, ready }
}

const waitFor = async (predicate, ms = 2000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

const TOOLS = [{ name: 'shell_exec', description: 'run', inputSchema: { type: 'object' } }]

test('a registered page advertises its tools and answers a call', async () => {
  const h = await harness()
  const page = fakePage(h.url, TOOLS, { shell_exec: (a) => ({ echoed: a.command }) })
  await page.ready
  assert.ok(await waitFor(() => h.bridge.attached === 1), 'the page attached')
  assert.ok(await waitFor(() => h.bridge.has('shell_exec')), 'the tool is advertised')

  const result = await h.bridge.call('shell_exec', { command: 'ls -la' })
  assert.deepEqual(result, { echoed: 'ls -la' })

  page.ws.close()
  await h.close()
})

test('a page that throws produces an error, not a hang', async () => {
  const h = await harness()
  const page = fakePage(h.url, TOOLS, {
    shell_exec: () => {
      throw new Error('the shell has not started')
    },
  })
  await page.ready
  await waitFor(() => h.bridge.has('shell_exec'))

  await assert.rejects(() => h.bridge.call('shell_exec', {}), /the shell has not started/)
  page.ws.close()
  await h.close()
})

test('with nothing attached, the error names the fix rather than the symptom', async () => {
  const h = await harness()
  // The whole design's most likely failure: the tool exists in the manifest the agent was handed,
  // and the page it needs is simply not open. "no such tool" would send someone hunting a typo.
  await assert.rejects(() => h.bridge.call('shell_exec', {}), /no editor is attached/)
  await h.close()
})

test('a page that disconnects mid-call fails that call at once', async () => {
  const h = await harness()
  // never answers — the call is in flight when the socket dies
  const page = fakePage(h.url, TOOLS, { shell_exec: () => new Promise(() => {}) })
  await page.ready
  await waitFor(() => h.bridge.has('shell_exec'))

  const inflight = h.bridge.call('shell_exec', {}, { timeoutMs: 30_000 })
  await waitFor(() => h.bridge.pending.size === 1)
  page.ws.terminate()

  // Without the close handler this would sit for the full 30s and report a timeout, which reads
  // as "the tool is slow" rather than "the editor went away".
  await assert.rejects(() => inflight, /disconnected/)
  await h.close()
})

test('the socket enforces the token', async () => {
  const auth = {
    required: true,
    check: (_req, url) => (url.searchParams.get('access_token') === 'right' ? { ok: true } : { ok: false, why: 'nope' }),
  }
  const h = await harness({ auth })

  const refused = new WebSocket(`${h.url}?access_token=wrong`)
  const code = await new Promise((resolve) => {
    refused.on('error', () => resolve('error'))
    refused.on('close', () => resolve('closed'))
    refused.on('open', () => resolve('OPENED'))
  })
  assert.notEqual(code, 'OPENED', 'a wrong token must not open the socket')
  assert.equal(h.bridge.attached, 0)

  const allowed = fakePage(`${h.url}?access_token=right`, TOOLS, { shell_exec: () => ({ ok: true }) })
  await allowed.ready
  assert.ok(await waitFor(() => h.bridge.attached === 1), 'the right token attaches')

  allowed.ws.close()
  await h.close()
})

test('two pages offering the same tool is not an error', async () => {
  const h = await harness()
  // the editor open in two tabs — the tools are the same tools
  const a = fakePage(h.url, TOOLS, { shell_exec: () => ({ from: 'a' }) }, { label: 'tab-a' })
  const b = fakePage(h.url, TOOLS, { shell_exec: () => ({ from: 'b' }) }, { label: 'tab-b' })
  await Promise.all([a.ready, b.ready])
  await waitFor(() => h.bridge.attached === 2)

  assert.equal(h.bridge.tools().filter((t) => t.name === 'shell_exec').length, 1, 'advertised once')
  const r = await h.bridge.call('shell_exec', {})
  assert.ok(['a', 'b'].includes(r.from), 'answered by one of them')

  a.ws.close()
  b.ws.close()
  await h.close()
})
