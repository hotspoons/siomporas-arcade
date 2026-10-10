// Two things a run now carries about OSM, against the same fake cluster the sharded tests use.
//
//   1. A BAKE is told which Overpass to read by the extract's real polygon, and is handed the
//      coverage file so it can refuse a query its instance does not hold (osm.py). dc-metro-take-2
//      went to the Maryland instance by a fence and came back without Washington or Virginia.
//   2. An OSM-IMPORT is a run like a bake: one Job, on the Overpass instance's node, with its volume
//      and its scripts ConfigMap; on success the instance's coverage gains the region.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Coverage } from './coverage.mjs'
import { Runs, osmImportJob } from './runs.mjs'
import { Store } from './store.mjs'
import { manifest } from '../overpass/osm-import-job.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, ms = 20000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(20) } }

const seed = JSON.parse(await readFile(new URL('./geofabrik-seed.json', import.meta.url), 'utf8'))
const F = (id) => seed.features.find((f) => f.properties.id === id) ?? null

function cluster({ overpassNode = 'gh200-1-node-2' } = {}) {
  const jobs = new Map()
  return {
    jobs,
    available: true,
    namespace: 'default',
    async createJob(spec) {
      jobs.set(spec.metadata.name, { status: { active: 1 }, spec })
      return { metadata: { name: spec.metadata.name } }
    },
    async getJob(name) {
      const j = jobs.get(name)
      if (!j) throw new Error(`no job ${name}`)
      return { metadata: { name }, status: j.status }
    },
    async podsFor(name) { return [{ metadata: { name: `${name}-pod` }, status: { phase: 'Running' } }] },
    async podsByLabel(sel) {
      if (!overpassNode || sel !== 'app=overpass') return []
      return [{ metadata: { name: 'overpass-abc' }, status: { phase: 'Running' }, spec: { nodeName: overpassNode } }]
    },
    async logStream() {
      const s = new PassThrough()
      s.statusCode = 200
      setTimeout(() => s.end(), 5)
      return s
    },
    async deleteJob(name) { jobs.set(name, { ...jobs.get(name), status: { failed: 1 } }) },
  }
}

async function setup(urls, regions) {
  const root = await mkdtemp(path.join(tmpdir(), 'runs-osm-'))
  const store = new Store(root)
  await store.init()
  const coverage = new Coverage(root, { urls: () => urls, regions: () => regions, lookup: async (id) => F(id) })
  await coverage.load()
  return { root, store, coverage }
}

const env = (spec) => Object.fromEntries(spec.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]))
const URLS = ['http://overpass/api/interpreter', 'http://overpass-na/api/interpreter']
const REGIONS = 'overpass=us/maryland, overpass-na=north-america'

test('a dc-metro-take-2 bake is handed overpass-na, the coverage file, and says why in its log', async () => {
  const { root, store, coverage } = await setup(URLS, REGIONS)
  const k8s = cluster()
  try {
    await store.putWorld({ slug: 'dc-metro-take-2', name: 'DC', lat: 38.911621, lon: -77.005045, radius_m: 19933, all_streets: true })
    const runs = new Runs(store, k8s, { force: 'kubernetes', image: 'corridor:latest', claim: 'data', resources: {}, coverage, overpassUrl: URLS.join(',') })
    const run = await runs.bake('dc-metro-take-2', { sharded: false })
    await until(() => k8s.jobs.size === 1)
    const e = env([...k8s.jobs.values()][0].spec)
    assert.equal(e.CORRIDOR_OVERPASS_URL, 'http://overpass-na/api/interpreter')
    assert.equal(e.CORRIDOR_OVERPASS_COVERAGE, '/data/overpass/coverage.json')
    assert.equal(e.CORRIDOR_OSM_REFRESH, undefined)
    const log = await readFile(store.logFile(run.id), 'utf8')
    assert.match(log, /OSM for dc-metro-take-2: overpass-na \(overpass 3\d\.\d% outside, overpass-na holds it\)/)
    // and the coverage file the bake will read is really there, with Maryland's polygon in it
    const doc = JSON.parse(await readFile(path.join(root, 'overpass', 'coverage.json'), 'utf8'))
    assert.equal(doc.upstreams.find((u) => u.name === 'overpass').regions[0].id, 'us/maryland')
    await runs.cancel(run.id)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('refreshOsm reaches the bake as CORRIDOR_OSM_REFRESH, in every Job of a sharded run', async () => {
  const { root, store, coverage } = await setup(URLS, REGIONS)
  const k8s = cluster()
  try {
    await store.putWorld({ slug: 'w', name: 'W', lat: 39.0, lon: -76.7, radius_m: 2000, all_streets: true })
    const runs = new Runs(store, k8s, { force: 'kubernetes', image: 'corridor:latest', claim: 'data', resources: {}, coverage, overpassUrl: URLS.join(',') })
    const run = await runs.bake('w', { sharded: true, refreshOsm: true })
    await until(() => k8s.jobs.size === 1)
    const e = env([...k8s.jobs.values()][0].spec)
    assert.equal(e.CORRIDOR_OSM_REFRESH, '1')
    // a Maryland world: the Maryland extract first
    assert.equal(e.CORRIDOR_OVERPASS_URL, URLS.join(','))
    assert.match(run.label, /fresh OSM/)
    await runs.cancel(run.id)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('an osm-import is one Job on the instance\'s node, with its volume and scripts, and adds coverage when it succeeds', async () => {
  const { root, store, coverage } = await setup(URLS, REGIONS)
  const k8s = cluster()
  try {
    const imported = []
    const runs = new Runs(store, k8s, {
      force: 'kubernetes',
      image: 'corridor:latest',
      claim: 'data',
      resources: {},
      coverage,
      osmImportImage: 'wiktorn/overpass-api@sha256:9bb5',
      onImported: async (r) => {
        imported.push(r.osm.region)
        await coverage.addRegion(r.osm.upstream, F(r.osm.region), { run: r.id })
      },
    })
    const run = await runs.osmImport({ upstream: 'overpass', region: F('us/virginia') })
    assert.equal(run.kind, 'osm-import')
    assert.match(run.label, /add Virginia to overpass/)
    await until(() => k8s.jobs.size === 1)
    const [job] = [...k8s.jobs.values()]
    const pod = job.spec.spec.template.spec
    assert.deepEqual(pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values, ['gh200-1-node-2'])
    assert.equal(pod.volumes.find((v) => v.name === 'db').persistentVolumeClaim.claimName, 'overpass-db')
    assert.equal(pod.volumes.find((v) => v.name === 'scripts').configMap.name, 'overpass-regions')
    assert.equal(pod.containers[0].image, 'wiktorn/overpass-api@sha256:9bb5')
    assert.deepEqual(pod.containers[0].command, ['/bin/bash', '/opt/regions/import.sh'])
    assert.equal(job.spec.spec.backoffLimit, 0)
    const e = env(job.spec)
    assert.equal(e.REGION_ID, 'us/virginia')
    assert.equal(e.PBF_URL, 'https://download.geofabrik.de/north-america/us/virginia-latest.osm.pbf')
    assert.equal(e.INTERPRETER, 'http://overpass/api/interpreter')

    // one at a time per instance: they share one disk and one dispatcher
    await assert.rejects(runs.osmImport({ upstream: 'overpass', region: F('us/district-of-columbia') }), /already has an import running/)

    // before: dc-metro goes to North America. The Job succeeds...
    job.status = { succeeded: 1 }
    await until(async () => JSON.parse(await readFile(store.runFile(run.id), 'utf8')).state === 'done')
    assert.deepEqual(imported, ['us/virginia'])
    const ov = coverage.upstreams().find((u) => u.name === 'overpass')
    assert.deepEqual(ov.regions.map((r) => r.id).sort(), ['us/maryland', 'us/virginia'])
    assert.match(await readFile(store.logFile(run.id), 'utf8'), /coverage: overpass now holds us\/virginia/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('an import is refused, by name, when the instance is not running or the editor is not in a cluster', async () => {
  const { root, store, coverage } = await setup(URLS, REGIONS)
  try {
    const down = new Runs(store, cluster({ overpassNode: null }), { force: 'kubernetes', coverage })
    await assert.rejects(down.osmImport({ upstream: 'overpass', region: F('us/virginia') }), /overpass has no running pod/)
    const laptop = new Runs(store, { ...cluster(), available: false }, { force: 'local', coverage })
    await assert.rejects(laptop.osmImport({ upstream: 'overpass', region: F('us/virginia') }), /not running in one/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('the reviewed manifest is exactly what the editor creates', async () => {
  // tools/overpass/osm-import-job.yaml is what an admin reads; this holds it to the code
  const onDisk = await readFile(new URL('../overpass/osm-import-job.yaml', import.meta.url), 'utf8')
  assert.equal(onDisk, manifest(osmImportJob), 'regenerate with: node tools/overpass/osm-import-job.mjs > tools/overpass/osm-import-job.yaml')
})
