// DEV-ONLY operator shell: a WebSocket channel from the Vite dev server into
// the live page, so an agent (or a human) can evaluate JS against the running
// game on a REAL GPU — renderer.info, scene traversal, the mutable game state,
// per-frame cost. Ported from trailworks' devbridge, which rode a Python
// backend's /api/ws; this repo has no backend, so the dev server carries it.
//
// OFF BY DEFAULT, AND OFF FOREVER IN A BUILD:
//   * `vite build` always gets the empty stub — the real client module is only
//     emitted while serving, so it cannot reach a production bundle.
//   * the switch is the APEX_BRIDGE env var (a token). Unset ⇒ the virtual
//     module resolves to empty no-ops, so not one byte of bridge code, and no
//     `window` handle onto the game, reaches the runtime.
//   * every request carries the token, so a stray page on the dev origin
//     can't drive the socket.
// Start it with `just bridge-dev <app>` (or APEX_BRIDGE=<token> npm run dev -w apps/<app>).

import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ViteDevServer } from 'vite'
import { WebSocketServer, type WebSocket } from 'ws'

export const VIRTUAL_ID = 'virtual:dev-bridge'
const RESOLVED_ID = '\0' + VIRTUAL_ID
const WS_PATH = '/__bridge/ws'
const EVAL_PATH = '/__bridge/eval'
const CLIENTS_PATH = '/__bridge/clients'
const DEFAULT_TIMEOUT_MS = 5000

const CLIENT_ENTRY = fileURLToPath(new URL('./bridge.ts', import.meta.url))

interface Client {
  id: number
  socket: WebSocket
  url: string
  ua: string
  connectedAt: number
}

interface Pending {
  resolve: (value: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

export function devBridge(): Plugin {
  const token = process.env.APEX_BRIDGE?.trim()
  let serving = false
  // Both conditions, every time: a token AND a dev server. `vite build` sets
  // `command: 'build'`, so a build can only ever load the stub.
  const enabled = () => Boolean(token) && serving

  return {
    name: 'apex-dev-bridge',

    configResolved(config) {
      serving = config.command === 'serve'
    },

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
      return null
    },

    load(id) {
      if (id !== RESOLVED_ID) return null
      if (!enabled()) {
        return `export function startDevBridge() {}
export function registerBridgeContext() {}
export const BRIDGE_ENABLED = false
`
      }
      // Enabled: a thin wrapper that closes over the token, so the real module
      // stays token-free and nothing has to be string-patched. This module only
      // exists while the dev server runs with the switch on.
      return `import { startDevBridge as start, registerBridgeContext } from ${JSON.stringify(CLIENT_ENTRY)}
export const BRIDGE_ENABLED = true
export { registerBridgeContext }
export function startDevBridge() { start(${JSON.stringify(token)}) }
`
    },

    configureServer(server) {
      if (!token) return
      attach(server, token)
    },
  }
}

function attach(server: ViteDevServer, token: string) {
  const clients = new Map<number, Client>()
  const pending = new Map<string, Pending>()
  let nextClientId = 1

  const wss = new WebSocketServer({ noServer: true })

  server.httpServer?.on('upgrade', (req, socket, head) => {
    // Only claim our own path — Vite's HMR socket shares this server, and
    // anything we don't handle must be left untouched for it.
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    if (pathname !== WS_PATH) return
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    let client: Client | null = null

    socket.on('message', (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>
      } catch {
        return
      }

      // First frame must be the handshake; anything else on an unregistered
      // socket is dropped.
      if (!client) {
        if (msg.hello !== token) {
          socket.close(4003, 'bad token')
          return
        }
        client = {
          id: nextClientId++,
          socket,
          url: String(msg.url ?? ''),
          ua: String(msg.ua ?? req.headers['user-agent'] ?? ''),
          connectedAt: Date.now(),
        }
        clients.set(client.id, client)
        server.config.logger.info(
          `  \x1b[32m➜\x1b[0m  bridge: page #${client.id} attached (${client.url})`,
        )
        return
      }

      const id = typeof msg.id === 'string' ? msg.id : null
      if (!id) return
      const waiter = pending.get(id)
      if (!waiter) return
      pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.resolve(msg)
    })

    socket.on('close', () => {
      if (client) clients.delete(client.id)
    })
  })

  server.middlewares.use((req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== EVAL_PATH && url.pathname !== CLIENTS_PATH) return next()

    if (req.headers['x-bridge-token'] !== token) {
      send(res, 403, { ok: false, error: 'bad or missing x-bridge-token' })
      return
    }

    if (url.pathname === CLIENTS_PATH) {
      send(res, 200, {
        ok: true,
        clients: [...clients.values()].map((c) => ({
          id: c.id,
          url: c.url,
          ua: c.ua,
          connectedAt: c.connectedAt,
        })),
      })
      return
    }

    void handleEval(req, res, clients, pending)
  })

  server.httpServer?.on('close', () => wss.close())
}

async function handleEval(
  req: IncomingMessage,
  res: ServerResponse,
  clients: Map<number, Client>,
  pending: Map<string, Pending>,
) {
  let body: { code?: string; target?: number; timeoutMs?: number }
  try {
    body = JSON.parse(await readBody(req)) as typeof body
  } catch {
    send(res, 400, { ok: false, error: 'body must be JSON: {code, target?, timeoutMs?}' })
    return
  }
  if (typeof body.code !== 'string' || !body.code.trim()) {
    send(res, 400, { ok: false, error: 'missing "code"' })
    return
  }

  // Default target is the most recently attached page — with one browser open
  // that's the only one, and with several it's the one you just opened.
  const list = [...clients.values()]
  const client = body.target ? clients.get(body.target) : list[list.length - 1]
  if (!client) {
    send(res, 503, { ok: false, error: 'no page attached — open the app in a browser' })
    return
  }

  const id = Math.random().toString(36).slice(2)
  const timeoutMs = body.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const reply = await new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, error: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    pending.set(id, { resolve, timer })
    client.socket.send(JSON.stringify({ id, code: body.code }))
  })
  send(res, 200, { target: client.id, ...(reply as object) })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      // An operator shell has no business receiving megabytes.
      if (data.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}
