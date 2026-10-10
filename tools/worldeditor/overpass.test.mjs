// Which Overpass upstream gets asked, for a box in a particular place.
//
// THE FAILURE THIS IS FOR. gh200-1 runs two extracts, each fenced to the region it holds:
//
//   http://overpass-eu/api/interpreter#34/-25/72/45          Europe
//   http://overpass/api/interpreter#37.9/-79.5/39.8/-75.0    the mid-Atlantic
//
// The service understands those fences. The BAKE does not — `osm.py` splits
// `CORRIDOR_OVERPASS_URL` on commas and posts to the first entry, and a `#fragment` is never sent
// on the wire. So handing the bake this whole string sent a Maryland world to the Europe extract,
// which answered HTTP 200 with zero elements, and the bake raised "no ways for roads [] within
// 1219 m of 38.998846,-76.692896". A working mirror, a correct query, and a silent empty — which
// is the family of failure this codebase has been bitten by repeatedly.
//
// So the service picks the upstreams and hands over a list that needs no fence.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mirrorsFor } from './overpass.mjs'

const CLUSTER = 'http://overpass-eu/api/interpreter#34/-25/72/45,http://overpass/api/interpreter#37.9/-79.5/39.8/-75.0'
const EU = 'http://overpass-eu/api/interpreter'
const NA = 'http://overpass/api/interpreter'

/** A square about a centre, the way a world's radius describes one. */
const around = (lat, lon, m = 1200) => ({
  south: lat - m / 111132,
  north: lat + m / 111132,
  west: lon - m / (111412.84 * Math.cos((lat * Math.PI) / 180)),
  east: lon + m / (111412.84 * Math.cos((lat * Math.PI) / 180)),
})

test('t-section gets the mid-Atlantic extract and NOT Europe', () => {
  // the exact coordinates out of the failed bake's own error message
  assert.deepEqual(mirrorsFor(CLUSTER, around(38.998846, -76.692896)), [NA])
})

test('a European world gets the European extract', () => {
  assert.deepEqual(mirrorsFor(CLUSTER, around(48.8566, 2.3522)), [EU])
})

test('somewhere neither covers gets NOTHING, so the bake falls through to the public mirrors', () => {
  // an empty list means the variable is left unset, and osm.py's own fallback list is the right
  // answer — claiming a mirror that cannot answer is how the silent empty happened
  assert.deepEqual(mirrorsFor(CLUSTER, around(35.6762, 139.6503)), [])
})

test('the fences are STRIPPED, because the bake would post the fragment as part of the path', () => {
  for (const u of mirrorsFor(CLUSTER, around(38.998846, -76.692896))) assert.ok(!u.includes('#'), u)
})

test('an unfenced upstream answers for everywhere, which is what a public mirror claims', () => {
  const mixed = `${CLUSTER},https://overpass-api.de/api/interpreter`
  assert.deepEqual(mirrorsFor(mixed, around(35.6762, 139.6503)), ['https://overpass-api.de/api/interpreter'])
  // and it is still offered where an extract also covers, as a fallback behind it
  assert.deepEqual(mirrorsFor(mixed, around(38.998846, -76.692896)), [NA, 'https://overpass-api.de/api/interpreter'])
})

test('with no box at all, every upstream is offered rather than guessed at', () => {
  assert.deepEqual(mirrorsFor(CLUSTER, null), [EU, NA])
})

test('the tightest fence that covers comes first, whatever order they are listed in', () => {
  // two that both cover, one tightly: ask the regional extract, which certainly has the data,
  // before the one claiming a continent — and do it from the listing that gets it wrong by luck
  const both = 'http://wide/api/interpreter#0/-180/80/180,http://tight/api/interpreter#38/-77/40/-76'
  assert.deepEqual(mirrorsFor(both, around(38.998846, -76.692896)), ['http://tight/api/interpreter', 'http://wide/api/interpreter'])
})

test('a box that straddles a fence edge is refused by it', () => {
  // the mid-Atlantic extract stops at 39.8 N; a world centred on the line is half missing, and
  // half a road network is worse than none because nothing says which half
  assert.deepEqual(mirrorsFor(CLUSTER, around(39.8, -76.7, 20_000)), [])
})

test('an empty or absent variable is not a crash', () => {
  for (const raw of ['', null, undefined, '   ', ',,']) assert.deepEqual(mirrorsFor(raw, around(38.99, -76.69)), [])
})

/* ---- what the map's client believes ---- */

import http from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Overpass } from './overpass.mjs'
import { Store } from './store.mjs'

/** A one-route Overpass that answers each POST with the next body in the list. */
async function fakeOverpass(bodies) {
  const seen = []
  const server = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => {
      seen.push(b)
      const body = bodies.shift() ?? { elements: [] }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/api/interpreter`, seen, close: () => new Promise((r) => server.close(r)) }
}

test('a runtime error in `remark` is a failure, not an empty answer, and is never cached', async () => {
  // measured on an instance taking an import: ~1 query in 100 answers HTTP 200 with
  // "runtime error: … Data file size does not match block size" and no elements
  const up = await fakeOverpass([
    { elements: [], remark: 'runtime error: open64: /db/db/ways.bin.idx File_Blocks_Index: Data file size does not match block size' },
    { elements: [{ type: 'way', id: 7, nodes: [1, 2], geometry: [{ lat: 39, lon: -76.7 }, { lat: 39.001, lon: -76.7 }], tags: { highway: 'residential', name: 'A' } }] },
  ])
  const root = await mkdtemp(path.join(tmpdir(), 'overpass-remark-'))
  try {
    const store = new Store(root)
    await store.init()
    const o = new Overpass(store, [up.url], { downForMs: 0, deadlineMs: 20000 })
    const r = await o.drivable({ south: 39, west: -76.71, north: 39.01, east: -76.69 })
    assert.equal(up.seen.length, 2, JSON.stringify(r).slice(0, 300))
    assert.equal(r.ways.length, 1, JSON.stringify(r).slice(0, 300))
    // nothing on the volume remembers the error as an answer
    const { readFile: rf } = await import('node:fs/promises')
    for (const f of await readdir(store.overpassCache)) assert.ok(!(await rf(path.join(store.overpassCache, f), 'utf8')).includes('runtime error'), f)
  } finally {
    await up.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('the map client skips an upstream whose TRUE coverage does not hold the box', async () => {
  // the Arlington box, an instance described as Maryland only, and one that claims everywhere
  const seed = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./geofabrik-seed.json', import.meta.url), 'utf8'))
  const md = seed.features.find((f) => f.properties.id === 'us/maryland').geometry
  const maryland = await fakeOverpass([{ elements: [] }])
  const everywhere = await fakeOverpass([{ elements: [{ type: 'way', id: 9, nodes: [1, 2], geometry: [{ lat: 38.88, lon: -77.1 }, { lat: 38.881, lon: -77.1 }], tags: { highway: 'residential' } }] }])
  const root = await mkdtemp(path.join(tmpdir(), 'overpass-cov-'))
  try {
    const store = new Store(root)
    await store.init()
    const o = new Overpass(store, [maryland.url, everywhere.url], { coverageOf: (u) => (u === maryland.url ? [md] : null) })
    const r = await o.drivable({ south: 38.87, west: -77.12, north: 38.89, east: -77.09 })
    assert.equal(maryland.seen.length, 0, 'the Maryland instance was never asked about Arlington')
    assert.equal(r.ways.length, 1)
  } finally {
    await maryland.close()
    await everywhere.close()
    await rm(root, { recursive: true, force: true })
  }
})
