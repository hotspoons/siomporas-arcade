// Does the platform client keep the token on this side, and get the tunnel contract right?
//
// The tunnel contract is the part with a trap in it, and patapsco-remote's own notes record what
// each wrong shape produces: OTP-as-bearer is a 401 "insufficient permissions", a PAT bearer with
// no `?t=` is a 401 "missing otp". Both are auth failures that look like a bad token, so the way
// this goes wrong is somebody re-entering their PAT for an hour.
//
// The other half is the token itself, which must never leave this process. Every response the
// module produces is searched for it.
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Platform, authorizeTunnel, validBase } from './platform.mjs'

const TOKEN = 'pat_this_must_never_leave_the_service'
const root = () => mkdtempSync(path.join(tmpdir(), 'platform-'))

test('authorizeTunnel puts the OTP in the query and the PAT in the headers', () => {
  const r = authorizeTunnel('wss://p.example/api/v1/remote-dev/tunnels/connect', 'otp-123', 'pat-abc')
  assert.equal(r.url, 'wss://p.example/api/v1/remote-dev/tunnels/connect?t=otp-123')
  assert.equal(r.headers.Authorization, 'Bearer pat-abc')
  // the mirror oauth2-proxy does not strip
  assert.equal(r.headers['X-PatapscoAI-Token'], 'pat-abc')
  // and NOT the other way round, which is the 401 that looks like a bad token
  assert.ok(!r.headers.Authorization.includes('otp-123'))
})

test('authorizeTunnel keeps a query string the URL already had', () => {
  const r = authorizeTunnel('wss://p.example/connect?port=9000', 'o', 'p')
  assert.equal(r.url, 'wss://p.example/connect?port=9000&t=o')
})

test('authorizeTunnel escapes a token with URL characters in it', () => {
  assert.ok(authorizeTunnel('wss://p/c', 'a+b/c=d', 'p').url.endsWith('?t=a%2Bb%2Fc%3Dd'))
})

test('validBase takes an https origin and refuses the rest', () => {
  assert.equal(validBase('https://platform.example.com'), null)
  assert.equal(validBase('https://platform.example.com:8443/base'), null)
  for (const b of ['http://platform.example.com', 'wss://p', 'javascript:alert(1)', '', 'platform.example.com']) {
    assert.ok(validBase(b), JSON.stringify(b))
  }
})

test('the credential is written 0600 and never comes back out', async () => {
  const dir = root()
  const p = new Platform(dir)
  await p.set({ base: 'https://platform.example.com', token: TOKEN, user: 'rich' })
  const mode = statSync(path.join(dir, '.platform-credential')).mode & 0o777
  assert.equal(mode, 0o600, `mode is ${mode.toString(8)}`)
  const info = await p.info()
  assert.deepEqual(info, { set: true, base: 'https://platform.example.com', user: 'rich' })
  assert.ok(!JSON.stringify(info).includes(TOKEN))
})

test('info on a service with no credential says so rather than throwing', async () => {
  assert.deepEqual(await new Platform(root()).info(), { set: false, base: null, user: null })
})

test('asking for agents with no credential is a 401, not a crash', async () => {
  await assert.rejects(() => new Platform(root()).agents(), (e) => e.status === 401)
})

test('the agent list is what the platform returned, and the token went in the headers', async () => {
  const seen = []
  const p = new Platform(root(), {
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers })
      return { ok: true, status: 200, json: async () => ({ deployments: [{ name: 'claude', phase: 'Running' }] }) }
    },
  })
  await p.set({ base: 'https://platform.example.com', token: TOKEN })
  const agents = await p.agents()
  assert.deepEqual(agents, [{ name: 'claude', phase: 'Running' }])
  assert.equal(seen[0].url, 'https://platform.example.com/api/v1/remote-dev/agents/deployments')
  assert.equal(seen[0].headers.Authorization, `Bearer ${TOKEN}`)
})

test('a tunnel mints a fresh OTP and authorizes with both halves', async () => {
  const calls = []
  const p = new Platform(root(), {
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body })
      return { ok: true, status: 200, json: async () => ({ token: 'otp-once', expires_in: 60 }) }
    },
  })
  await p.set({ base: 'https://platform.example.com', token: TOKEN })
  const t = await p.tunnel({ kind: 'agent', namespace: 'ns', name: 'claude', tunnelClass: 'pty' })
  assert.equal(calls.length, 1)
  assert.ok(calls[0].url.endsWith('/api/v1/remote-dev/tunnels/otp'))
  assert.deepEqual(JSON.parse(calls[0].body), { kind: 'agent', namespace: 'ns', name: 'claude', class: 'pty' })
  assert.equal(t.url, 'wss://platform.example.com/api/v1/remote-dev/tunnels/connect?t=otp-once')
  assert.equal(t.headers.Authorization, `Bearer ${TOKEN}`)
})

test('every tunnel mints its own OTP, because they are single use', async () => {
  let n = 0
  const p = new Platform(root(), {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ token: `otp-${++n}` }) }),
  })
  await p.set({ base: 'https://platform.example.com', token: TOKEN })
  const a = await p.tunnel({ kind: 'agent', namespace: 'ns', name: 'x', tunnelClass: 'pty' })
  const b = await p.tunnel({ kind: 'agent', namespace: 'ns', name: 'x', tunnelClass: 'pty' })
  assert.notEqual(a.url, b.url)
})

test('a refused mint says the platform refused rather than reporting success', async () => {
  const p = new Platform(root(), {
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ error: 'insufficient permissions' }) }),
  })
  await p.set({ base: 'https://platform.example.com', token: TOKEN })
  await assert.rejects(() => p.tunnel({ kind: 'agent', namespace: 'n', name: 'x', tunnelClass: 'pty' }),
    (e) => /insufficient permissions/.test(e.message) && e.status === 401)
})

test('a mint that answers 200 with no token is an error, not an empty tunnel', async () => {
  const p = new Platform(root(), { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) })
  await p.set({ base: 'https://platform.example.com', token: TOKEN })
  await assert.rejects(() => p.tunnel({ kind: 'agent', namespace: 'n', name: 'x', tunnelClass: 'pty' }), /no token in it/)
})

test('a base that is not https is refused before anything is stored', async () => {
  const p = new Platform(root())
  await assert.rejects(() => p.set({ base: 'http://plain.example.com', token: TOKEN }), /https/)
  assert.equal((await p.info()).set, false)
})

test('clearing removes it', async () => {
  const p = new Platform(root())
  await p.set({ base: 'https://platform.example.com', token: TOKEN })
  await p.clear()
  assert.equal((await p.info()).set, false)
})
