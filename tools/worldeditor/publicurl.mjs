// Where an agent outside this page reaches the MCP server, as this server sees itself.
//
// Rich, 2026-09-30: "the mcp server config from the UI doesn't match the protocol" — the page was
// on https://worldeditor…/ and the snippet said http://worldeditor…/api/agent/mcp. The server sat
// behind an ingress that terminated TLS, so its own socket was plain HTTP and `http://` plus the
// Host header was all it knew. A reverse proxy says what the client actually used:
// `X-Forwarded-Proto` and `X-Forwarded-Host` (the first value of each, since proxies append).
//
//   WORLDEDITOR_PUBLIC_URL      wins outright when set — the operator knows the address
//   X-Forwarded-Proto / -Host   what the ingress saw
//   Host, http                  a bare server on a laptop

/** The first value of a header that proxies may have chained with commas. */
function first(v) {
  if (Array.isArray(v)) v = v[0]
  return typeof v === 'string' ? v.split(',')[0].trim() : ''
}

export function publicMcpUrl(headers, env, port) {
  const fixed = env.WORLDEDITOR_PUBLIC_URL
  if (fixed) return `${fixed.replace(/\/$/, '')}/api/agent/mcp`
  const proto = first(headers['x-forwarded-proto']) || 'http'
  const host = first(headers['x-forwarded-host']) || first(headers.host) || `localhost:${port}`
  return `${/^https?$/.test(proto) ? proto : 'http'}://${host}/api/agent/mcp`
}
