// The MCP snippet must carry the scheme the page was opened with when the service is this page's
// own host — the https page that handed out an http address (Rich, 2026-09-30).
import { describe, expect, it } from 'vitest'
import { sameOriginScheme } from '../src/ui/mcppanel'

describe('sameOriginScheme', () => {
  const at = (protocol: string, host: string) => ({ protocol, host })
  it('upgrades http to https on the page’s own host', () => {
    expect(sameOriginScheme('http://we.example.com/api/agent/mcp', at('https:', 'we.example.com'))).toBe('https://we.example.com/api/agent/mcp')
  })
  it('leaves a different host alone, whatever its scheme', () => {
    expect(sameOriginScheme('http://127.0.0.1:8780/api/agent/mcp', at('https:', 'we.example.com'))).toBe('http://127.0.0.1:8780/api/agent/mcp')
  })
  it('leaves a matching scheme alone and survives junk', () => {
    expect(sameOriginScheme('https://we.example.com/api/agent/mcp', at('https:', 'we.example.com'))).toBe('https://we.example.com/api/agent/mcp')
    expect(sameOriginScheme('not a url', at('https:', 'h'))).toBe('not a url')
  })
})
