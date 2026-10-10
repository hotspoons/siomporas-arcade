// Routing by what an Overpass instance ACTUALLY holds.
//
// THE FAILURE, measured 2026-10-10 against gh200-1 through port-forwards:
//
//                     overpass (Maryland)   overpass-na
//   Arlington box            0                 4,346
//   downtown Washington      0                 6,418
//   College Park         5,185                 5,185      <- the control
//
// The fence on `overpass` (#37.9/-79.5/39.8/-75.0) claimed all of those, and "tightest fence that
// covers" sent dc-metro-take-2 to it. 35.3% of the world's square is outside maryland.poly; the
// bake shipped 108,816 roads in Maryland and none across the river. These tests use the REAL
// Geofabrik polygons (geofabrik-seed.json) and the REAL world.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Coverage, areaInBox, bakeArea, boxArea, clipRing, outsideFraction, parseRegions, parseUpstream, pointIn, route } from './coverage.mjs'
import { mirrorsFor } from './overpass.mjs'

const seed = JSON.parse(await readFile(new URL('./geofabrik-seed.json', import.meta.url), 'utf8'))
const F = (id) => seed.features.find((f) => f.properties.id === id)
const MD = F('us/maryland').geometry
const VA = F('us/virginia').geometry
const DC = F('us/district-of-columbia').geometry
const NA = F('north-america').geometry
const EU = F('europe').geometry

// dc-metro-take-2, as the deployed editor holds it (GET /api/worlds, 2026-10-10)
const DC_METRO = { slug: 'dc-metro-take-2', lat: 38.911621, lon: -77.005045, radius_m: 19933 }
// what the bake itself asks for: the geodetic box of its UTM square, from corridor.geo.Frame
const DC_METRO_BAKE = { south: 38.72795519222667, west: -77.24044548871936, north: 39.09487915067008, east: -76.77080061999021 }
const CROFTON = { slug: 'crofton-triangle', lat: 39.007758, lon: -76.670706, radius_m: 5260 }
const CROFTON_BAKE = { south: 38.95949417551713, west: -76.73258691798829, north: 39.055992743158505, east: -76.60890603372998 }

const box = (s, w, n, e) => ({ south: s, west: w, north: n, east: e })
const ARLINGTON = box(38.87, -77.12, 38.89, -77.09)
const COLLEGE_PARK = box(38.98, -76.95, 39.0, -76.92)
const DOWNTOWN = box(38.88, -77.04, 38.9, -77.01)

const CLUSTER_FENCES = 'http://overpass-eu/api/interpreter#34/-25/72/45,http://overpass/api/interpreter#37.9/-79.5/39.8/-75.0,http://overpass-na/api/interpreter#14.5/-179.9/83.5/-12'
const UPSTREAMS = [
  { name: 'overpass-eu', url: 'http://overpass-eu/api/interpreter', geoms: [EU] },
  { name: 'overpass', url: 'http://overpass/api/interpreter', geoms: [MD] },
  { name: 'overpass-na', url: 'http://overpass-na/api/interpreter', geoms: [NA] },
]

/* ---- containment, on the real Maryland / Virginia line ---- */

test('College Park is inside Maryland; Arlington and downtown Washington are not', () => {
  assert.equal(outsideFraction([MD], COLLEGE_PARK).outside, 0)
  assert.equal(outsideFraction([MD], ARLINGTON).outside, 1)
  assert.equal(outsideFraction([MD], DOWNTOWN).outside, 1)
  // and Virginia holds Arlington, North America all three
  assert.equal(outsideFraction([VA], ARLINGTON).outside, 0)
  for (const b of [COLLEGE_PARK, ARLINGTON, DOWNTOWN]) assert.equal(outsideFraction([NA], b).outside, 0)
})

test('dc-metro-take-2 is 35% outside the Maryland extract and wholly inside North America', () => {
  const f = outsideFraction([MD], bakeArea(DC_METRO))
  assert.ok(f.exact)
  assert.ok(f.outside > 0.33 && f.outside < 0.38, `${f.outside}`)
  assert.equal(outsideFraction([NA], bakeArea(DC_METRO)).outside, 0)
})

test('the editor routes on a box that holds the one the bake will ask for', () => {
  // bakeArea pads for the UTM square's rotation; if it ever fell inside the bake's real box, a
  // world on an extract's edge would be routed to an instance the bake then refuses
  for (const [w, real] of [[DC_METRO, DC_METRO_BAKE], [CROFTON, CROFTON_BAKE]]) {
    const b = bakeArea(w)
    assert.ok(b.south < real.south && b.west < real.west && b.north > real.north && b.east > real.east, `${w.slug}: ${JSON.stringify(b)} vs ${JSON.stringify(real)}`)
  }
})

test('clipping is exact: a box wholly inside keeps its area, a box half over the edge keeps half', () => {
  const sq = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] }
  assert.equal(areaInBox(sq, box(2, 2, 4, 4)), 4)
  assert.equal(areaInBox(sq, box(2, 8, 4, 12)), 4)
  assert.equal(outsideFraction([sq], box(2, 8, 4, 12)).outside, 0.5)
  // a hole takes its area back out
  const holed = { type: 'Polygon', coordinates: [sq.coordinates[0], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] }
  assert.equal(outsideFraction([holed], box(4, 4, 6, 6)).outside, 1)
  assert.ok(!pointIn(holed, 5, 5) && pointIn(holed, 1, 1))
  assert.equal(clipRing([[20, 20], [30, 20], [30, 30]], box(0, 0, 10, 10)).length, 0)
  assert.equal(boxArea(box(0, 0, 2, 3)), 6)
})

/* ---- routing ---- */

test('dc-metro-take-2 now routes to overpass-na', () => {
  const r = route(UPSTREAMS, bakeArea(DC_METRO))
  assert.deepEqual(r.urls, ['http://overpass-na/api/interpreter'])
  const md = r.verdicts.find((v) => v.name === 'overpass')
  assert.equal(md.covered, false)
  assert.ok(md.outside > 0.33, `${md.outside}`)
})

test('...and the old fences would have routed it to overpass, which is the bug', () => {
  // the deployed value, verbatim: Maryland's box is the tightest fence that "covers"
  assert.deepEqual(mirrorsFor(CLUSTER_FENCES, bakeArea(DC_METRO))[0], 'http://overpass/api/interpreter')
})

test('a Maryland world still goes to the Maryland extract first, North America second', () => {
  assert.deepEqual(route(UPSTREAMS, bakeArea(CROFTON)).urls, ['http://overpass/api/interpreter', 'http://overpass-na/api/interpreter'])
})

test('a world nothing of ours holds gets nothing, and so the public mirrors', () => {
  assert.deepEqual(route(UPSTREAMS, box(35.6, 139.6, 35.7, 139.8)).urls, [])
})

test('an instance with several regions holds what their union holds', () => {
  // Maryland and Virginia on one instance still miss the District, which is its own extract;
  // with the District too, the union holds dc-metro (sampled, and it says so)
  const two = route([{ name: 'overpass', url: 'u', geoms: [MD, VA] }], bakeArea(DC_METRO)).verdicts[0]
  assert.equal(two.covered, false)
  assert.equal(two.exact, false)
  const three = route([{ name: 'overpass', url: 'u', geoms: [MD, VA, DC] }], bakeArea(DC_METRO)).verdicts[0]
  assert.equal(three.covered, true, `${three.outside}`)
})

test('an unfenced upstream claims everywhere and sorts last; a described-but-empty one is never asked', () => {
  const ups = [...UPSTREAMS, { name: 'mirror', url: 'https://m/api/interpreter', geoms: null }, { name: 'broken', url: 'http://b/api/interpreter', geoms: [] }]
  const r = route(ups, bakeArea(CROFTON))
  assert.deepEqual(r.urls.at(-1), 'https://m/api/interpreter')
  assert.ok(!r.urls.includes('http://b/api/interpreter'))
})

/* ---- configuration ---- */

test('the regions setting names regions per instance, several joined with +', () => {
  const m = parseRegions('overpass=us/maryland+us/virginia, overpass-na=north-america;overpass-eu = europe')
  assert.deepEqual(m.get('overpass'), ['us/maryland', 'us/virginia'])
  assert.deepEqual(m.get('overpass-na'), ['north-america'])
  assert.deepEqual(m.get('overpass-eu'), ['europe'])
  assert.equal(parseUpstream('http://overpass/api/interpreter#37.9/-79.5/39.8/-75.0').fence.north, 39.8)
  assert.equal(parseUpstream('http://localhost:18082/api/interpreter').name, 'localhost:18082')
})

async function coverageAt(urls, regions) {
  const dir = await mkdtemp(path.join(tmpdir(), 'coverage-'))
  const state = { urls, regions }
  const c = new Coverage(dir, { urls: () => state.urls, regions: () => state.regions, lookup: async (id) => F(id) ?? null })
  await c.load()
  return { c, dir, state }
}

test('the deployment seeds coverage; an import adds to it and survives the setting changing', async () => {
  const { c, dir, state } = await coverageAt(
    ['http://overpass/api/interpreter', 'http://overpass-na/api/interpreter'],
    'overpass=us/maryland, overpass-na=north-america',
  )
  try {
    assert.deepEqual(c.route(bakeArea(DC_METRO)).urls, ['http://overpass-na/api/interpreter'])
    // import Virginia and the District into `overpass`: now it holds dc-metro, and is tighter
    await c.addRegion('overpass', F('us/virginia'), { run: 'r1' })
    await c.addRegion('overpass', F('us/district-of-columbia'), { run: 'r2' })
    assert.deepEqual(c.route(bakeArea(DC_METRO)).urls, ['http://overpass/api/interpreter', 'http://overpass-na/api/interpreter'])
    // the file is on the volume, and a reload with a CHANGED setting keeps the imports
    state.regions = 'overpass-na=north-america'
    const again = new Coverage(dir, { urls: () => state.urls, regions: () => state.regions, lookup: async (id) => F(id) ?? null })
    await again.load()
    const ids = again.upstreams().find((u) => u.name === 'overpass').regions.map((r) => `${r.id}:${r.source}`)
    assert.deepEqual(ids.sort(), ['us/district-of-columbia:import', 'us/virginia:import'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a fence stands in only for an instance with no regions, and a region that cannot be outlined is not "everywhere"', async () => {
  const { c, dir } = await coverageAt(['http://overpass/api/interpreter#37.9/-79.5/39.8/-75.0', 'http://lost/api/interpreter'], 'lost=nowhere/atlantis')
  try {
    const ups = c.upstreams()
    assert.equal(ups[0].regions[0].source, 'fence')
    // the silent empty's own shape: a region nobody can draw must not become "claims everywhere"
    assert.deepEqual(ups[1].geoms, [])
    assert.ok(c.problems.some((p) => /atlantis/.test(p)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an instance can be named explicitly, for port-forwards where every host is localhost', () => {
  const u = parseUpstream('overpass-na=http://localhost:18082/api/interpreter')
  assert.deepEqual([u.name, u.url], ['overpass-na', 'http://localhost:18082/api/interpreter'])
  // and the old rule strips the name too, so it never reaches the wire
  assert.deepEqual(mirrorsFor('overpass=http://localhost:18081/api/interpreter#37.9/-79.5/39.8/-75.0', bakeArea(CROFTON)), ['http://localhost:18081/api/interpreter'])
})
