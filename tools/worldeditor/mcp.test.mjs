// Does the MCP surface reach the same documents as everything else, and only those?
//
// TWO CLAIMS. The first is that it is the SAME documents: `worlds/crofton-triangle.json` has to
// mean the same thing at the shell prompt, in the browser and here, or an agent is told two
// different things about what exists.
//
// The second is the boundary. Every path an agent sends is a string it chose, and this is the one
// place in the editor where a remote thing names a file. So the tests try to leave.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { TOOLS, callTool, handle, listDocs, resolveDoc } from './mcp.mjs'
import * as levels from './levels.mjs'

function volume() {
  const root = mkdtempSync(path.join(tmpdir(), 'mcp-'))
  const put = (rel, text) => {
    const p = path.join(root, rel)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
  put('worlds/crofton-triangle.json', '{"slug":"crofton-triangle","lat":39,"lon":-76,"radius_m":1000}')
  put('levels/rooftop.json', '{"id":"rooftop","world":"crofton-triangle"}')
  put('programs/rooftop.ts', 'export default 1\n')
  put('sites/crofton-triangle/tuning.json', '{"version":1,"values":{}}')
  put('sites/crofton-triangle/dem_1m.tif', 'not really a tif')
  put('cache/overpass/huge.json', '{}')
  return { root, put }
}

/** The service's own store and validator, as the server is given them. */
function ctxFor(root) {
  const written = []
  return {
    written,
    ctx: {
      root,
      levels,
      store: {
        putProgram: async (id, source) => { written.push(['program', id, source]); return { id } },
        putLevel: async (level) => { written.push(['level', level.id, level]); return level },
        putWorld: async (world) => { written.push(['world', world.slug, world]); return world },
        putAuthored: async (rel, body) => { written.push(['authored', rel, String(body)]); return body.length },
      },
    },
  }
}

test('resolveDoc accepts exactly the documents the projection projects', () => {
  const { root } = volume()
  for (const p of ['worlds/a.json', 'levels/bb.json', 'programs/cc.ts', 'sites/d/tuning.json', 'sites/d/presets.json']) {
    assert.ok(resolveDoc(root, p), p)
  }
})

test('resolveDoc uses the SERVICE\u2019s own rule per kind, not one of its own', () => {
  // levels.mjs and store.putProgram both want at least two characters; a world slug comes from
  // slugify, which has no minimum. Accepting a one-character level id here would fail at the
  // write, with a message about a slug the agent did not choose
  const { root } = volume()
  assert.ok(resolveDoc(root, 'worlds/a.json'))
  assert.equal(resolveDoc(root, 'levels/b.json'), null)
  assert.equal(resolveDoc(root, 'programs/c.ts'), null)
})

test('resolveDoc refuses everything else, including the bake and the cache', () => {
  const { root } = volume()
  for (const p of [
    '../../etc/passwd',
    'worlds/../../etc/passwd',
    '/etc/passwd',
    'worlds/..%2f..%2fetc%2fpasswd',
    'cache/overpass/huge.json',
    'sites/crofton-triangle/dem_1m.tif',
    'sites/crofton-triangle/tiles/0_0.ktx2',
    '.git-credentials',
    '.platform-credential',
    'worlds/a.json/../../.git-credentials',
    'programs/a/b.ts',
    'worlds/A.json',
    '',
    null,
  ]) {
    assert.equal(resolveDoc(root, p), null, JSON.stringify(p))
  }
})

test('a path is BUILT from a matched slug, so there is nothing to escape from', () => {
  const { root } = volume()
  const at = resolveDoc(root, 'worlds/crofton-triangle.json')
  assert.equal(at.file, path.join(root, 'worlds', 'crofton-triangle.json'))
  assert.ok(at.file.startsWith(root + path.sep))
})

test('list_documents lists the authored half and nothing else', async () => {
  const { root } = volume()
  const { ctx } = ctxFor(root)
  const r = await callTool('list_documents', {}, ctx)
  const lines = r.content[0].text.split('\n')
  assert.deepEqual(lines, [
    'levels/rooftop.json',
    'programs/rooftop.ts',
    'sites/crofton-triangle/tuning.json',
    'worlds/crofton-triangle.json',
  ])
  assert.ok(!r.content[0].text.includes('dem_1m'))
  assert.ok(!r.content[0].text.includes('cache/'))
})

test('listDocs and resolveDoc agree: everything listed can be read', async () => {
  const { root } = volume()
  for (const p of await listDocs(root)) assert.ok(resolveDoc(root, p), p)
})

test('read_document returns the text, and says so when there is none', async () => {
  const { root } = volume()
  const { ctx } = ctxFor(root)
  assert.match((await callTool('read_document', { path: 'programs/rooftop.ts' }, ctx)).content[0].text, /export default 1/)
  const missing = await callTool('read_document', { path: 'worlds/nope.json' }, ctx)
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /no document/)
})

test('read_document refuses a path outside the documents, with the way to find one', async () => {
  const { root } = volume()
  const { ctx } = ctxFor(root)
  const r = await callTool('read_document', { path: '../../etc/passwd' }, ctx)
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /list_documents/)
})

test('write_document goes through the store, so validation is not skipped', async () => {
  const { root } = volume()
  const { ctx, written } = ctxFor(root)
  const r = await callTool('write_document', { path: 'levels/rooftop.json', content: '{"id":"rooftop","world":"crofton-triangle"}' }, ctx)
  assert.ok(!r.isError, r.content[0].text)
  assert.equal(written[0][0], 'level')
  assert.equal(written[0][1], 'rooftop')
})

test('an invalid level is REFUSED rather than written and reported', async () => {
  // "saved, with errors" gives an agent no reason to fix them, and the next thing to open that
  // level is a person wondering why it will not
  const { root } = volume()
  const { ctx, written } = ctxFor(root)
  const r = await callTool('write_document', { path: 'levels/rooftop.json', content: '{"id":"rooftop","world":"crofton-triangle","mode":"teleport"}' }, ctx)
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /mode/)
  assert.equal(written.length, 0)
})

test('a scenario testing something nothing measures is refused, with the facts that exist', async () => {
  const { root } = volume()
  const { ctx } = ctxFor(root)
  const r = await callTool('write_document', {
    path: 'levels/rooftop.json',
    content: JSON.stringify({ id: 'rooftop', world: 'crofton-triangle', scenario: { events: [{ when: 'rage_meter > 5', then: [{ action: 'end', outcome: 'win' }] }] } }),
  }, ctx)
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /rage_meter/)
  assert.match(r.content[0].text, /score/) // the facts that do exist, in the message
})

test('write_document refuses text that is not JSON before the store sees it', async () => {
  const { root } = volume()
  const { ctx, written } = ctxFor(root)
  const r = await callTool('write_document', { path: 'worlds/crofton-triangle.json', content: 'slug: crofton' }, ctx)
  assert.equal(r.isError, true)
  assert.equal(written.length, 0)
})

test('a program may be any text, but not an unbounded amount of it', async () => {
  const { root } = volume()
  const { ctx, written } = ctxFor(root)
  assert.ok(!(await callTool('write_document', { path: 'programs/rooftop.ts', content: 'not json at all' }, ctx)).isError)
  assert.equal(written[0][0], 'program')
  const big = await callTool('write_document', { path: 'programs/rooftop.ts', content: 'x'.repeat(600 * 1024) }, ctx)
  assert.equal(big.isError, true)
})

test('validate_level answers without writing, and names the vocabulary', async () => {
  const { root } = volume()
  const { ctx, written } = ctxFor(root)
  const r = await callTool('validate_level', { level: { id: 'rooftop', world: 'crofton-triangle' } }, ctx)
  const v = JSON.parse(r.content[0].text)
  assert.equal(v.ok, true)
  assert.ok(v.facts.includes('score'))
  assert.ok(v.actions.includes('spawn'))
  assert.equal(written.length, 0)
})

test('the protocol: initialize, tools/list, tools/call', async () => {
  const { root } = volume()
  const { ctx } = ctxFor(root)
  const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx)
  assert.equal(init.result.serverInfo.name, 'corridor-world-editor')
  assert.ok(init.result.capabilities.tools)

  const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx)
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name))
  for (const t of list.result.tools) {
    assert.ok(t.description, `${t.name} has no description`)
    assert.equal(t.inputSchema.type, 'object')
  }

  const call = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_documents', arguments: {} } }, ctx)
  assert.match(call.result.content[0].text, /worlds\/crofton-triangle\.json/)
})

test('a notification gets no reply, which is what JSON-RPC requires', async () => {
  const { root } = volume()
  const { ctx } = ctxFor(root)
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null)
})

test('a method it does not have is a proper error, not a silence', async () => {
  const { root } = volume()
  const { ctx } = ctxFor(root)
  const r = await handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' }, ctx)
  assert.equal(r.error.code, -32601)
})

test('a tool that throws comes back as a failed TOOL, not a broken server', async () => {
  // MCP distinguishes the two, and reporting a failed tool as a protocol error makes an agent
  // stop using the server rather than fix its arguments
  const { root } = volume()
  const { ctx } = ctxFor(root)
  ctx.store.putProgram = async () => { throw new Error('the volume is full') }
  const r = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_document', arguments: { path: 'programs/rooftop.ts', content: 'x' } } }, ctx)
  assert.equal(r.error, undefined)
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /volume is full/)
})

test('a tool nobody has is refused by name', async () => {
  const { root } = volume()
  const { ctx } = ctxFor(root)
  const r = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } }, ctx)
  assert.equal(r.error.code, -32602)
})

test('every tool says what it is, and the dangerous one says that it is', () => {
  for (const t of TOOLS) assert.ok(t.description.length > 30, t.name)
  const write = TOOLS.find((t) => t.name === 'write_document')
  assert.match(write.description, /LIVE EDIT/)
  assert.match(write.description, /no undo/)
})

test('a document written through MCP reads back the same through the file', async () => {
  // the claim that this is the same documents, not a parallel set
  const { root } = volume()
  const { ctx } = ctxFor(root)
  ctx.store.putProgram = async (id, source) => {
    writeFileSync(path.join(root, 'programs', `${id}.ts`), source)
    return { id }
  }
  await callTool('write_document', { path: 'programs/rooftop.ts', content: 'export default 42\n' }, ctx)
  assert.match(readFileSync(path.join(root, 'programs', 'rooftop.ts'), 'utf8'), /42/)
  assert.match((await callTool('read_document', { path: 'programs/rooftop.ts' }, ctx)).content[0].text, /42/)
})
