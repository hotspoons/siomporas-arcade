// The browser's end of an agent tunnel: a WebSocket this service relays to the platform's.
//
// WHY A RELAY AND NOT A DIRECT CONNECTION. The platform's tunnel wants the PAT in an
// `Authorization` header and a single-use OTP in `?t=`. A browser's WebSocket constructor takes a
// URL and a subprotocol and nothing else — there is no way to set a header on it — so a page can
// satisfy half of the contract and not the other half. Everything else that gets suggested here is
// worse: putting the PAT in the query string writes it into every proxy log between the two ends,
// and a subprotocol smuggle is the same thing with extra steps.
//
// It is also where the token belongs. The same argument as the git credential: a personal access
// token that reaches the browser is one in a screenshot, in a bug report, and in the devtools of
// whoever is pairing.
//
// BYTES THROUGH, NOTHING ELSE. This does not parse ACP, or JSON-RPC, or anything: it is a pipe.
// The client end speaks the protocol and so does the agent, and a relay that understood the
// protocol would be a third implementation of it to keep in step.
import { WebSocketServer, WebSocket } from 'ws'

/** How long a relay may sit with nothing going through it before it is closed. */
const IDLE_MS = 10 * 60_000

/**
 * Attach the relay to an HTTP server.
 *
 * `path` is where the browser connects; the query says which agent. One upstream connection per
 * browser connection, opened only after the OTP is minted — so a page that connects and is refused
 * costs one mint and no upstream socket.
 */
export function attachAgentRelay(server, { platform, path: route = '/api/agent/tunnel', log = console } = {}) {
  const wss = new WebSocketServer({ noServer: true })
  const live = new Set()

  server.on('upgrade', (req, socket, head) => {
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== route) return // another upgrade handler may want it

    wss.handleUpgrade(req, socket, head, (client) => {
      void relay(client, url, platform, live, log)
    })
  })

  return {
    get connections() { return live.size },
    close() {
      for (const pair of live) pair.close()
      wss.close()
    },
  }
}

async function relay(client, url, platform, live, log) {
  const want = {
    kind: url.searchParams.get('kind') ?? 'agent',
    namespace: url.searchParams.get('namespace') ?? '',
    name: url.searchParams.get('name') ?? '',
    tunnelClass: url.searchParams.get('class') ?? 'pty',
    port: url.searchParams.get('port') ?? undefined,
  }
  if (!want.name) {
    // 1008 is "policy violation", which is the closest thing a WebSocket has to a 400. The REASON
    // matters more than the code: a page that is told only "closed" shows a spinner for ever.
    client.close(1008, 'no agent named')
    return
  }

  let upstream
  const pair = { close: () => { try { client.close() } catch { /* already gone */ } try { upstream?.close() } catch { /* already gone */ } } }
  live.add(pair)

  /*
   * LISTEN BEFORE AWAITING.
   *
   * Minting the OTP is a round trip to the platform, and the browser sends its `initialize` the
   * moment its own socket opens — which is inside that window. A handler attached after the await
   * is attached after those frames have already arrived and been dropped, and the symptom is an
   * agent session that connects and then waits for ever for a request that was sent.
   */
  const queued = []
  let sendUp = (data) => queued.push(data)
  client.on('message', (data) => sendUp(data))

  try {
    const { url: wsUrl, headers } = await platform.tunnel(want)
    upstream = new WebSocket(wsUrl, { headers })
  } catch (e) {
    // the message is the platform's own, because "insufficient permissions" and "missing otp" mean
    // two different things to fix and both look like a bad token
    client.close(1011, String(e.message ?? e).slice(0, 120))
    live.delete(pair)
    return
  }

  let idle = setTimeout(() => pair.close(), IDLE_MS)
  const touch = () => {
    clearTimeout(idle)
    idle = setTimeout(() => pair.close(), IDLE_MS)
  }

  // and once the upstream is up, everything held goes through and the queue stops being used
  upstream.on('open', () => {
    sendUp = (data) => { touch(); upstream.send(data) }
    for (const m of queued.splice(0)) upstream.send(m)
  })

  upstream.on('message', (data) => {
    touch()
    if (client.readyState === WebSocket.OPEN) client.send(data)
  })

  const done = (why) => {
    clearTimeout(idle)
    live.delete(pair)
    pair.close()
    if (why) log.warn?.(`agent tunnel: ${why}`)
  }
  client.on('close', () => done(null))
  upstream.on('close', (code, reason) => done(code === 1000 ? null : `upstream closed ${code} ${reason}`))
  client.on('error', (e) => done(`browser side: ${e.message}`))
  upstream.on('error', (e) => {
    // an upstream that never opened has told the client nothing; say why before closing it
    if (client.readyState === WebSocket.OPEN && upstream.readyState !== WebSocket.OPEN) {
      client.close(1011, String(e.message ?? e).slice(0, 120))
    }
    done(`platform side: ${e.message}`)
  })
}
