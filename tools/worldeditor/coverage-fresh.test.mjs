// A FRESH DEPLOYMENT ROUTES TO ITS OWN INSTANCES FROM THE FIRST BAKE.
//
// THE FAILURE, 2026-10-10: the split's test bake of a world in Crofton, Maryland, on a new volume,
// with `overpass=us/maryland` configured, logged
//
//   OSM for smoke-world: no instance of ours holds all of it — public mirrors (overpass 100.0% outside)
//
// and the mirrors answered 504. The editor had fetched Geofabrik's index of that day, which lists
// us/maryland (and us/virginia, and nine more) with `"coordinates": []`, recorded that as Maryland's
// outline on the volume, and from then on the Maryland instance held nothing — with no problem
// reported. The index of the day before had every outline.
//
// These open the coverage the way server.mjs does (`openCoverage`), on an empty directory, with the
// index served by a fake fetch built from the vendored seed's REAL outlines — never the network.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { bakeArea, hasOutline, openCoverage } from './coverage.mjs'
import { Geofabrik } from './geofabrik.mjs'

const seed = JSON.parse(await readFile(new URL('./geofabrik-seed.json', import.meta.url), 'utf8'))
const clone = (x) => JSON.parse(JSON.stringify(x))

/** Filler regions, so the index passes the "fewer than 50 regions is not a catalogue" check. */
const filler = Array.from({ length: 60 }, (_, i) => ({
  type: 'Feature',
  properties: { id: `filler/${i}`, name: `Filler ${i}`, urls: { pbf: `https://x/filler-${i}-latest.osm.pbf` } },
  geometry: { type: 'Polygon', coordinates: [[[100 + i * 0.1, -50], [100.05 + i * 0.1, -50], [100.05 + i * 0.1, -49.95], [100 + i * 0.1, -50]]] },
}))
const japan = { type: 'Feature', properties: { id: 'japan', name: 'Japan', urls: { pbf: 'https://download.geofabrik.de/asia/japan-latest.osm.pbf' } }, geometry: { type: 'MultiPolygon', coordinates: [] } }

/** The whole index as Geofabrik served it on 2026-10-09: every region outlined. */
const COMPLETE = { type: 'FeatureCollection', features: [...clone(seed.features), clone(japan), ...filler] }
COMPLETE.features.find((f) => f.properties.id === 'japan').geometry = { type: 'Polygon', coordinates: [[[129, 30], [146, 30], [146, 46], [129, 46], [129, 30]]] }
/** ... and on 2026-10-10 (Last-Modified 03:55:30 GMT): us/maryland, us/virginia, japan and eight more with no outline. */
const OUTLINELESS = { type: 'FeatureCollection', features: [...clone(seed.features), clone(japan), ...filler] }
for (const f of OUTLINELESS.features) if (['us/maryland', 'us/virginia'].includes(f.properties.id)) f.geometry = { type: 'MultiPolygon', coordinates: [] }

const serves = (doc) => async () => ({ ok: true, status: 200, json: async () => clone(doc) })
const unreachable = async () => { throw new Error('getaddrinfo ENOTFOUND download.geofabrik.de') }

// the deployment's configuration, as deploy/gh200-1/worldeditor.yaml writes it
const URLS = ['overpass=http://overpass/api/interpreter', 'overpass-eu=http://overpass-eu/api/interpreter', 'overpass-na=http://overpass-na/api/interpreter']
const REGIONS = 'overpass=us/maryland,overpass-na=north-america,overpass-eu=europe'

const CROFTON_MD = { slug: 'md', lat: 39.02, lon: -76.68, radius_m: 900 }
const ARLINGTON_VA = { slug: 'va', lat: 38.88, lon: -77.1, radius_m: 900 }
const PARIS = { slug: 'eu', lat: 48.8566, lon: 2.3522, radius_m: 900 }
const TOKYO = { slug: 'jp', lat: 35.68, lon: 139.76, radius_m: 900 }

const quiet = () => {
  const lines = []
  return { lines, log: (s) => lines.push(['log', s]), warn: (s) => lines.push(['warn', s]) }
}

async function fresh(fetch, { urls = URLS, regions = REGIONS, dir = null, ...g } = {}) {
  dir ??= await mkdtemp(path.join(tmpdir(), 'coverage-fresh-'))
  const log = quiet()
  const geofabrik = new Geofabrik(dir, { fetch, log, ...g })
  const { coverage, refresh } = await openCoverage(dir, { urls: () => urls, regions: () => regions, geofabrik, log })
  const first = (w) => {
    const r = coverage.route(bakeArea(w))
    const names = new Map(coverage.upstreams().map((u) => [u.url, u.name]))
    return r.urls.length ? names.get(r.urls[0]) : 'public mirrors'
  }
  return { dir, geofabrik, coverage, refresh, first, log }
}

const ROUTES = [[CROFTON_MD, 'overpass'], [ARLINGTON_VA, 'overpass-na'], [PARIS, 'overpass-eu']]

for (const [label, index] of [['every outline (2026-10-09)', COMPLETE], ['Maryland and Virginia outline-less (2026-10-10)', OUTLINELESS]]) {
  test(`a fresh volume routes Maryland, Virginia and Europe to their instances — index with ${label}`, async () => {
    const t = await fresh(serves(index))
    try {
      // the first request, before the live index has been read: the seed's outlines
      for (const [w, want] of ROUTES) assert.equal(t.first(w), want, `before the refresh: ${w.slug}`)
      await t.refresh()
      assert.equal(t.geofabrik.source, 'geofabrik')
      for (const [w, want] of ROUTES) assert.equal(t.first(w), want, `after the refresh: ${w.slug}`)
      // and the next process on the same volume — what a restarted pod reads, offline
      const again = await fresh(async () => { throw new Error('should not ask') }, { dir: t.dir })
      for (const [w, want] of ROUTES) assert.equal(again.first(w), want, `after a restart: ${w.slug}`)
      // what the bake reads (osm.py, CORRIDOR_OVERPASS_COVERAGE): every region outlined
      const file = JSON.parse(await readFile(path.join(t.dir, 'overpass', 'coverage.json'), 'utf8'))
      const regions = file.upstreams.flatMap((u) => u.regions.map((r) => [u.name, r.id, hasOutline(r.geometry)]))
      assert.deepEqual(regions.sort(), [['overpass', 'us/maryland', true], ['overpass-eu', 'europe', true], ['overpass-na', 'north-america', true]])
      assert.deepEqual(t.coverage.problems, [])
    } finally {
      await rm(t.dir, { recursive: true, force: true })
    }
  })
}

test('the split\'s sequence: the index is cached first, the instances configured after — still routed', async () => {
  // 21:29 the editor started on a new volume with no Overpass configured and cached the live index;
  // 21:39 it was restarted with overpass=us/maryland, read that copy offline, and recorded nothing
  const t = await fresh(serves(OUTLINELESS), { urls: [], regions: '' })
  try {
    await t.refresh()
    const restarted = await fresh(async () => { throw new Error('offline') }, { dir: t.dir })
    for (const [w, want] of ROUTES) assert.equal(restarted.first(w), want, `restarted with the instances: ${w.slug}`)
    // and an import of Virginia onto `overpass`, recorded from the same index, holds Arlington
    await restarted.coverage.addRegion('overpass', await restarted.geofabrik.region('us/virginia'))
    assert.equal(restarted.first(ARLINGTON_VA), 'overpass')
  } finally {
    await rm(t.dir, { recursive: true, force: true })
  }
})

test('an outline Geofabrik left empty is taken from the seed, said so, and written to the volume that way', async () => {
  const t = await fresh(serves(OUTLINELESS))
  try {
    await t.refresh()
    const st = t.geofabrik.status()
    assert.deepEqual(st.outlinesFromElsewhere.map((p) => p.id).sort(), ['us/maryland', 'us/virginia'])
    assert.deepEqual(st.missingOutlines, ['japan'], 'a region nobody can outline is listed')
    assert.deepEqual(st.problems, [], 'japan is configured nowhere: listed, not a problem')
    const vol = JSON.parse(await readFile(path.join(t.dir, 'overpass', 'geofabrik-index.json'), 'utf8'))
    assert.ok(hasOutline(vol.features.find((f) => f.properties.id === 'us/maryland').geometry))
    assert.ok(t.log.lines.some(([, s]) => /outline\(s\) Geofabrik left empty.*us\/maryland/.test(s)))
  } finally {
    await rm(t.dir, { recursive: true, force: true })
  }
})

test('a region nobody can outline is a problem and holds nothing — never "claims everywhere"', async () => {
  const t = await fresh(serves(OUTLINELESS), {
    urls: [...URLS, 'overpass-jp=http://overpass-jp/api/interpreter'],
    regions: `${REGIONS},overpass-jp=japan`,
  })
  try {
    await t.refresh()
    assert.ok(t.coverage.problems.some((p) => /overpass-jp: region "japan" has no outline/.test(p)), t.coverage.problems.join('\n'))
    const jp = t.coverage.upstreams().find((u) => u.name === 'overpass-jp')
    assert.deepEqual(jp.geoms, [], 'described and unoutlined: holds nothing, never asked')
    assert.equal(t.first(TOKYO), 'public mirrors')
    assert.equal(t.first(CROFTON_MD), 'overpass')
    assert.ok(t.log.lines.some(([k, s]) => k === 'warn' && /japan/.test(s)))
  } finally {
    await rm(t.dir, { recursive: true, force: true })
  }
})

test('a Geofabrik that does not answer is reported — log and status — and the seed still routes', async () => {
  let calls = 0
  const t = await fresh(async (...a) => { calls++; return unreachable(...a) })
  try {
    await t.refresh()
    for (const [w, want] of ROUTES) assert.equal(t.first(w), want, w.slug)
    const st = t.geofabrik.status()
    assert.equal(st.source, 'seed')
    assert.match(st.error?.message ?? '', /ENOTFOUND/)
    assert.ok(st.problems.some((p) => /Geofabrik index not fetched \(getaddrinfo ENOTFOUND/.test(p) && /vendored seed/.test(p)), st.problems.join('\n'))
    assert.ok(t.log.lines.some(([k, s]) => k === 'warn' && /GEOFABRIK INDEX NOT FETCHED.*ENOTFOUND/.test(s)), JSON.stringify(t.log.lines))
    // not asked again on every lookup: a failed fetch can take its whole timeout
    await t.refresh()
    await t.geofabrik.region('us/maryland')
    assert.equal(calls, 1)
  } finally {
    await rm(t.dir, { recursive: true, force: true })
  }
})

test('after a failure, the next refresh past the retry window asks again and clears the problem', async () => {
  let answer = unreachable
  const t = await fresh((...a) => answer(...a), { retryMs: 0 })
  try {
    await t.refresh()
    assert.ok(t.geofabrik.status().error)
    answer = serves(COMPLETE)
    await t.refresh()
    const st = t.geofabrik.status()
    assert.equal(st.source, 'geofabrik')
    assert.equal(st.error, null)
    assert.deepEqual(st.problems, [])
  } finally {
    await rm(t.dir, { recursive: true, force: true })
  }
})

test('a volume that took the outline-less index before this check heals on start-up', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coverage-fresh-'))
  try {
    // what the split's scratch volume held: the 2026-10-10 index, and Maryland recorded as nothing
    await mkdir(path.join(dir, 'overpass'), { recursive: true })
    await writeFile(path.join(dir, 'overpass', 'geofabrik-index.json'), JSON.stringify(OUTLINELESS))
    const md = OUTLINELESS.features.find((f) => f.properties.id === 'us/maryland')
    await writeFile(path.join(dir, 'overpass', 'coverage.json'), JSON.stringify({
      version: 1,
      upstreams: [{ name: 'overpass', url: 'http://overpass/api/interpreter', regions: [{ id: 'us/maryland', name: 'Maryland', source: 'deploy', geometry: md.geometry }] }],
    }))
    const t = await fresh(async () => { throw new Error('offline') }, { dir })
    for (const [w, want] of ROUTES) assert.equal(t.first(w), want, w.slug)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an import of a region with no outline is refused rather than recorded as nothing', async () => {
  const t = await fresh(serves(OUTLINELESS))
  try {
    await t.refresh()
    await assert.rejects(t.coverage.addRegion('overpass', OUTLINELESS.features.find((f) => f.properties.id === 'japan')), /no outline/)
  } finally {
    await rm(t.dir, { recursive: true, force: true })
  }
})
