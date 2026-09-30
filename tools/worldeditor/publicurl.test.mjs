// The MCP URL the editor hands out must be the one a client can actually open.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publicMcpUrl } from './publicurl.mjs'

test('behind an ingress that terminated TLS, the scheme is the one the client used', () => {
  const h = { host: '10.0.3.7:8780', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'worldeditor.example.com' }
  assert.equal(publicMcpUrl(h, {}, 8780), 'https://worldeditor.example.com/api/agent/mcp')
})

test('a chain of proxies: the first value counts', () => {
  const h = { host: 'worldeditor.example.com', 'x-forwarded-proto': 'https, http' }
  assert.equal(publicMcpUrl(h, {}, 8780), 'https://worldeditor.example.com/api/agent/mcp')
})

test('a bare server on a laptop is plain http on its Host', () => {
  assert.equal(publicMcpUrl({ host: 'localhost:8780' }, {}, 8780), 'http://localhost:8780/api/agent/mcp')
  assert.equal(publicMcpUrl({}, {}, 8780), 'http://localhost:8780/api/agent/mcp')
})

test('the operator’s public URL wins, with or without a trailing slash', () => {
  const h = { host: 'x', 'x-forwarded-proto': 'https' }
  assert.equal(publicMcpUrl(h, { WORLDEDITOR_PUBLIC_URL: 'https://we.example.com/' }, 8780), 'https://we.example.com/api/agent/mcp')
  assert.equal(publicMcpUrl(h, { WORLDEDITOR_PUBLIC_URL: 'https://we.example.com' }, 8780), 'https://we.example.com/api/agent/mcp')
})

test('a scheme that is not a scheme falls back to http rather than being echoed', () => {
  assert.equal(publicMcpUrl({ host: 'h', 'x-forwarded-proto': 'javascript' }, {}, 1), 'http://h/api/agent/mcp')
})
