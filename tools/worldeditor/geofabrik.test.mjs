// The Geofabrik catalogue: where coverage polygons come from, and what happens when Geofabrik does
// not answer. Routing the deployment's own instances must never wait on Germany at boot, and a 200
// with nothing in it is not a catalogue (the silent-success family again).
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Geofabrik } from './geofabrik.mjs'

const tmp = () => mkdtemp(path.join(tmpdir(), 'geofabrik-'))
const features = (n) => Array.from({ length: n }, (_, i) => ({ type: 'Feature', properties: { id: `r${i}`, name: `R${i}`, urls: { pbf: `https://x/r${i}-latest.osm.pbf` } }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }))

test('offline, a new volume routes from the vendored seed and never calls out', async () => {
  const dir = await tmp()
  try {
    let called = 0
    const g = new Geofabrik(dir, { fetch: async () => { called++; throw new Error('no route') } })
    const md = await g.region('us/maryland', { offline: true })
    assert.equal(called, 0)
    assert.equal(md.properties.id, 'us/maryland')
    assert.equal(g.source, 'seed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('online, the live index is kept on the volume; a 200 with almost nothing in it is refused', async () => {
  const dir = await tmp()
  try {
    const empty = new Geofabrik(dir, { fetch: async () => ({ ok: true, json: async () => ({ features: features(3) }) }) })
    await empty.index()
    assert.match(empty.source, /seed/, 'three regions is not the catalogue; the seed stands in')
    const good = new Geofabrik(dir, { fetch: async () => ({ ok: true, json: async () => ({ features: features(120) }) }) })
    await good.index()
    assert.equal(good.source, 'geofabrik')
    assert.ok((await stat(path.join(dir, 'overpass', 'geofabrik-index.json'))).size > 1000)
    // and the next process reads the volume rather than asking again
    let called = 0
    const again = new Geofabrik(dir, { fetch: async () => { called++; throw new Error('should not ask') } })
    assert.equal((await again.list()).regions.length, 120)
    assert.equal(called, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
