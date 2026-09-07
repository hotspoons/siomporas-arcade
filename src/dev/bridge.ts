// Browser half of the dev operator shell. Reached ONLY through the
// `virtual:dev-bridge` module, which the dev-server plugin resolves to empty
// no-ops unless APEX_BRIDGE is set — so importing this file is not something
// app code should ever do directly.
//
// It opens a WebSocket back to the dev server; when an operator POSTs JS to
// /__bridge/eval the server relays it here, it runs against the live page and
// a JSON-safe result goes back. The point is introspecting a real browser on a
// real GPU: renderer.info, the mutable game state mid-run, scene traversal,
// frame cost — the things a headless assertion can't see.

/** Handles the evaluated code gets as `apex`, plus `window.__apex`. */
let context: Record<string, unknown> = {}
let started = false

/**
 * JSON-safe serializer: caps depth and size, unwraps Three math types and
 * typed arrays compactly, tags functions, breaks cycles — so an eval that
 * returns `scene` or `renderer.info` comes back as inspectable data instead of
 * blowing up JSON.stringify.
 */
function safe(v: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || v === undefined) return v
  if (typeof v === 'string') return v.length > 4000 ? v.slice(0, 4000) + '…' : v
  if (typeof v === 'function') return `«fn ${(v as { name?: string }).name || 'anonymous'}»`
  if (typeof v === 'bigint') return String(v)
  if (typeof v !== 'object') return String(v)
  const o = v as Record<string, unknown>
  if (seen.has(o)) return '«circular»'
  if (depth > 6) return '«…»'
  seen.add(o)

  if (ArrayBuffer.isView(v) || Array.isArray(v)) {
    const arr = v as ArrayLike<unknown>
    if (arr.length > 64) {
      return {
        _type: (v as object).constructor?.name,
        length: arr.length,
        head: Array.from({ length: 8 }, (_, i) => safe(arr[i], depth + 1, seen)),
      }
    }
    return Array.from(arr, (x) => safe(x, depth + 1, seen))
  }

  const ctor = (v as object).constructor?.name
  if (ctor && /^(Vector[234]|Quaternion|Euler|Color|Box3|Sphere|Matrix[34])$/.test(ctor)) {
    const el = (v as { elements?: ArrayLike<number> }).elements
    if (el) return { _type: ctor, elements: Array.from(el) }
    return {
      _type: ctor,
      ...Object.fromEntries(
        ['x', 'y', 'z', 'w', 'r', 'g', 'b'].filter((k) => k in o).map((k) => [k, o[k]]),
      ),
    }
  }

  const out: Record<string, unknown> = {}
  let n = 0
  for (const k in o) {
    if (n++ > 80) {
      out['…'] = `+${Object.keys(o).length - 80} more`
      break
    }
    try {
      const val = o[k]
      if (typeof val === 'function') continue // methods are noise in a dump
      out[k] = safe(val, depth + 1, seen)
    } catch {
      out[k] = '«throws»'
    }
  }
  if (ctor && ctor !== 'Object') out._type = ctor
  return out
}

/**
 * Publish live handles for the shell to poke at. Called from the app on mount;
 * a no-op build when the bridge is off, so nothing is exposed by default.
 */
export function registerBridgeContext(ctx: Record<string, unknown>): void {
  // Copy descriptors, not values: `get snap()` must stay live, not be frozen
  // to whatever it returned at registration time.
  Object.defineProperties(context, Object.getOwnPropertyDescriptors(ctx))
  ;(window as unknown as Record<string, unknown>).__apex = context
}

export function startDevBridge(token: string): void {
  if (started) return
  started = true

  let retry = 0
  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/__bridge/ws`)

    ws.onopen = () => {
      retry = 0
      ws.send(JSON.stringify({ hello: token, url: location.href, ua: navigator.userAgent }))
      console.info('%c[bridge] operator shell attached', 'color:#39ff81')
    }

    ws.onmessage = async (ev) => {
      let req: { id?: string; code?: string }
      try {
        req = JSON.parse(String(ev.data)) as typeof req
      } catch {
        return
      }
      if (!req.id || typeof req.code !== 'string') return
      const reply = (m: object) => ws.send(JSON.stringify({ id: req.id, ...m }))
      try {
        // Try the code as an EXPRESSION first (`apex.game.v`, `2+2`); if that
        // won't even construct — statements, `const`, several lines — fall back
        // to a body wrapper, where the caller supplies its own `return`.
        // Construction has to be inside the try: a SyntaxError throws at
        // `new Function`, not at call time.
        let fn: (apex: Record<string, unknown>) => Promise<unknown>
        try {
          fn = new Function('apex', `return (async () => (${req.code}\n))()`) as typeof fn
        } catch {
          fn = new Function('apex', `return (async () => { ${req.code}\n })()`) as typeof fn
        }
        reply({ ok: true, result: safe(await fn(context)) })
      } catch (e) {
        reply({ ok: false, error: String((e as Error)?.stack || e) })
      }
    }

    ws.onclose = () => {
      // The dev server restarts constantly; back off, but keep coming back.
      retry = Math.min(retry + 1, 6)
      setTimeout(connect, 500 * 2 ** retry)
    }
    ws.onerror = () => ws.close()
  }
  connect()
}
