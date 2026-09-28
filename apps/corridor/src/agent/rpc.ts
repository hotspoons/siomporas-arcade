// JSON-RPC 2.0 over any byte stream.
//
// LIFTED, ALMOST UNCHANGED, from patapsco-remote (src/core/acp/jsonRpc.ts). Rich cloned that
// client under ext/ and said to embed its pieces rather than write a second one, and this is the
// piece with no VS Code and no Node in it: a transport interface and a peer that speaks both
// directions of the protocol. The changes are the lint rules this repo uses and nothing else.
//
// BOTH DIRECTIONS MATTERS. ACP is not a client calling a server: the agent asks the CLIENT for
// things — read this file, run this command, may I edit that — so a peer that could only make
// requests would connect, send a prompt and hang on the agent's first question.
export interface JsonRpcTransport {
  send(payload: string): void
  onMessage(cb: (payload: string) => void): void
  onClose(cb: (err?: Error) => void): void
  close(): void
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown
export type NotificationHandler = (params: unknown) => void
interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  method: string
}

export class RpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

const PARSE_ERROR = -32700
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603
export class JsonRpcPeer {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly requests = new Map<string, RequestHandler>()
  private readonly notifications = new Map<string, NotificationHandler>()
  private closed?: Error
  private readonly transport: JsonRpcTransport
  private readonly onProtocolError?: (message: string) => void

  constructor(transport: JsonRpcTransport, onProtocolError?: (message: string) => void) {
    this.transport = transport
    this.onProtocolError = onProtocolError
    transport.onMessage((payload) => this.receive(payload))
    transport.onClose((err) => this.fail(err ?? new Error('transport closed')))
  }

  handle(method: string, handler: RequestHandler): void {
    this.requests.set(method, handler)
  }

  notify(method: string, handler: NotificationHandler): void {
    this.notifications.set(method, handler)
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method })
    })
    this.transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return promise
  }

  send(method: string, params?: unknown): void {
    if (this.closed) return
    this.transport.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  close(): void {
    this.transport.close()
    this.fail(new Error('closed locally'))
  }

  private fail(err: Error): void {
    if (this.closed) return
    this.closed = err
    for (const [, p] of this.pending) {
      p.reject(new Error(`${p.method}: ${err.message}`))
    }
    this.pending.clear()
  }

  private receive(payload: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(payload) as Record<string, unknown>
    } catch {
      this.onProtocolError?.(`unparseable JSON-RPC frame: ${payload.slice(0, 120)}`)
      return
    }
    if (Array.isArray(msg)) {
      for (const one of msg) this.receive(JSON.stringify(one))
      return
    }

    const id = msg.id
    if (typeof msg.method === 'string') {
      void this.dispatch(msg.method, msg.params, id)
      return
    }
    if (typeof id !== 'number') {
      this.onProtocolError?.('response with no usable id')
      return
    }
    const pending = this.pending.get(id)
    if (!pending) {
      this.onProtocolError?.(`response for unknown id ${id}`)
      return
    }
    this.pending.delete(id)
    if (msg.error) {
      const e = msg.error as JsonRpcError
      pending.reject(new RpcError(e?.code ?? INTERNAL_ERROR, e?.message || 'rpc error', e?.data))
      return
    }
    pending.resolve(msg.result)
  }

  private async dispatch(method: string, params: unknown, id: unknown): Promise<void> {
    if (id === undefined || id === null) {
      const handler = this.notifications.get(method)
      if (!handler) { this.onProtocolError?.(`unhandled notification ${method}`); return; }
      try { handler(params); }
      catch (err) { this.onProtocolError?.(`notification ${method} threw: ${describe(err)}`); }
      return
    }
    const handler = this.requests.get(method)
    if (!handler) {
      this.reply(id, undefined, { code: METHOD_NOT_FOUND, message: `method not found: ${method}` })
      return
    }
    try {
      this.reply(id, await handler(params))
    } catch (err) {
      const code = err instanceof RpcError ? err.code : INTERNAL_ERROR
      this.reply(id, undefined, { code, message: describe(err) })
    }
  }

  private reply(id: unknown, result?: unknown, error?: JsonRpcError): void {
    if (this.closed) return
    this.transport.send(JSON.stringify(error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result: result ?? null }))
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const RPC_PARSE_ERROR = PARSE_ERROR