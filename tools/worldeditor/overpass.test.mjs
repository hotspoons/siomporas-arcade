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
