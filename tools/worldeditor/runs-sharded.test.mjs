// A sharded bake runs plan -> shard -> finalize as ONE run with many Jobs.
//
// The worldeditor is the orchestrator: it creates the plan Job, reads `plan/shards.json` off the
// volume to learn how many shards there are, creates that many shard Jobs at once (spread across
// nodes), and only then the finalizer. These tests drive a fake cluster through all three phases
// and assert the Jobs, their arguments, and the run's terminal state.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Runs } from './runs.mjs'
import { Store } from './store.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, ms = 20000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(20) } }

/** A cluster that records the Jobs it is asked to make and lets a test finish them. */
function cluster() {
  const jobs = new Map() // name -> { status, spec }
  return {
    jobs,
    available: true,
    namespace: 'default',
    async createJob(spec) {
      const name = spec.metadata.name
      jobs.set(name, { status: { active: 1 }, spec })
      return { metadata: { name } }
    },
    async getJob(name) {
      const j = jobs.get(name)
      if (!j) throw new Error(`no job ${name}`)
      return { metadata: { name }, status: j.status }
    },
    async podsFor(name) {
      return [{ metadata: { name: `${name}-pod` }, status: { phase: 'Running' } }]
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

const commands = (jobs) => [...jobs.values()].map((j) => j.spec.spec.template.spec.containers[0].command.join(' '))
const finish = (jobs, suffix) => { for (const [name, j] of jobs) if (name.includes(suffix)) j.status = { succeeded: 1 } }

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'runs-sharded-'))
  const store = new Store(root)
  await store.init()
  await mkdir(path.join(store.sites, 'w', 'plan'), { recursive: true })
  await writeFile(path.join(store.sites, 'w', 'plan', 'shards.json'), JSON.stringify({ n: 2, blocks: [{ index: 0 }, { index: 1 }] }))
  return { root, store }
}

test('a sharded run goes plan -> 2 shards -> finalize and ends done', async () => {
  const { root, store } = await setup()
  const k8s = cluster()
  try {
    const runs = new Runs(store, k8s, { force: 'kubernetes', image: 'corridor:latest', claim: 'data', resources: {} })
    const run = await runs.bake('w', { sharded: true })
    await until(() => commands(k8s.jobs).length === 1)
    assert.deepEqual(commands(k8s.jobs)[0], 'python -m corridor plan w')

    // the plan Job succeeds; the orchestrator reads n=2 and creates both shards
    finish(k8s.jobs, '-plan-')
    await until(() => commands(k8s.jobs).filter((c) => c.includes(' shard ')).length === 2)
    const shardCmds = commands(k8s.jobs).filter((c) => c.includes(' shard '))
    assert.ok(shardCmds.some((c) => c.endsWith(' w 0')), shardCmds.join(' | '))
    assert.ok(shardCmds.some((c) => c.endsWith(' w 1')), shardCmds.join(' | '))
    // shard Jobs are spread across hostnames
    for (const j of k8s.jobs.values()) {
      if (j.spec.spec.template.spec.containers[0].command.includes('shard')) {
        assert.equal(j.spec.spec.template.spec.topologySpreadConstraints?.[0]?.topologyKey, 'kubernetes.io/hostname')
      }
    }

    // both shards succeed; the finalizer appears
    finish(k8s.jobs, '-shard-')
    await until(() => commands(k8s.jobs).some((c) => c.includes(' finalize ')))
    finish(k8s.jobs, '-finalize-')

    await until(async () => {
      const j = JSON.parse(await readFile(store.runFile(run.id), 'utf8'))
      return j.state === 'done'
    })
    const onDisk = JSON.parse(await readFile(store.runFile(run.id), 'utf8'))
    assert.equal(onDisk.phase, 'finalize')
    assert.equal(onDisk.shardCount, 2)
    runs.live.get(run.id)?.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed shard cancels its siblings and fails the run', async () => {
  const { root, store } = await setup()
  const k8s = cluster()
  const deleted = []
  k8s.deleteJob = async (name) => { deleted.push(name) }
  try {
    const runs = new Runs(store, k8s, { force: 'kubernetes', image: 'corridor:latest', claim: 'data', resources: {} })
    const run = await runs.bake('w', { sharded: true })
    await until(() => commands(k8s.jobs).length === 1)
    finish(k8s.jobs, '-plan-')
    await until(() => commands(k8s.jobs).filter((c) => c.includes(' shard ')).length === 2)

    // one shard fails
    const shardNames = [...k8s.jobs.keys()].filter((n) => n.includes('-shard-'))
    k8s.jobs.get(shardNames[0]).status = { failed: 1 }

    await until(async () => {
      const j = JSON.parse(await readFile(store.runFile(run.id), 'utf8'))
      return j.state === 'failed'
    })
    const onDisk = JSON.parse(await readFile(store.runFile(run.id), 'utf8'))
    assert.match(onDisk.detail, /shard Job .* failed/)
    assert.ok(deleted.includes(shardNames[1]), 'the surviving sibling was cancelled')
    runs.live.get(run.id)?.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a plan that yields no shards fails instead of hanging', async () => {
  const { root, store } = await setup()
  await writeFile(path.join(store.sites, 'w', 'plan', 'shards.json'), JSON.stringify({ n: 0 }))
  const k8s = cluster()
  try {
    const runs = new Runs(store, k8s, { force: 'kubernetes', image: 'corridor:latest', claim: 'data', resources: {} })
    const run = await runs.bake('w', { sharded: true })
    await until(() => commands(k8s.jobs).length === 1)
    finish(k8s.jobs, '-plan-')
    await until(async () => {
      const j = JSON.parse(await readFile(store.runFile(run.id), 'utf8'))
      return j.state === 'failed'
    })
    const onDisk = JSON.parse(await readFile(store.runFile(run.id), 'utf8'))
    assert.match(onDisk.detail, /no shards/)
    runs.live.get(run.id)?.stop()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
