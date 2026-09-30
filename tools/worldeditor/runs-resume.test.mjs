// A bake log survives the editor pod being replaced mid-bake, WITHOUT being written twice.
//
// Rich, 2026-09-30, of the crofton-triangle bake: "It looks like it ran twice but it never
// finished." It ran once. The editor was redeployed while it ran; the run record said
// `lastStamp: null` because the stamp was only saved when a log stream ENDED, and a bake's stream
// ends when the bake does. The new pod adopted the run, resumed from nothing, and appended the
// whole log again.
//
// The first follower here is abandoned mid-stream, not ended: a killed process runs no 'end'
// handler, and letting the stream end would save the stamp and hide exactly the bug.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Runs } from './runs.mjs'
import { Store } from './store.mjs'

const ID = 'bake-crofton-triangle-test'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = (i) => `2026-09-30T01:${String(20 + i).padStart(2, '0')}:00.000000000Z`
const LINES = Array.from({ length: 8 }, (_, i) => `${stamp(i)} line ${i}`)

/** A cluster with one running Job whose pod log is LINES, served from `sinceTime` like the API. */
function cluster() {
  const streams = []
  return {
    streams,
    available: true,
    getJob: async () => ({ status: { active: 1 } }),
    podsFor: async () => [{ metadata: { name: 'bake-pod' }, status: { phase: 'Running' } }],
    logStream: async (_pod, { sinceTime }) => {
      const s = new PassThrough()
      s.statusCode = 200
      s.backlog = LINES.filter((l) => !sinceTime || l.split(' ')[0] >= sinceTime)
      streams.push(s)
      return s
    },
  }
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'runs-'))
  const store = new Store(root)
  await store.init()
  const run = { id: ID, kind: 'bake', slug: 'crofton-triangle', runner: 'kubernetes', state: 'running', started: '2026-09-30T01:19:42.839Z', job: 'bake-job', pod: null, lastStamp: null }
  await writeFile(store.runFile(ID), JSON.stringify(run))
  await writeFile(store.logFile(ID), '=== bake crofton-triangle (kubernetes)\n')
  return { root, store }
}
const until = async (f, ms = 8000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(20) } }
const logLines = async (store) => (await readFile(store.logFile(ID), 'utf8')).split('\n').filter((l) => l.startsWith('line '))

/** Pod A follows, writes the first `n` lines, then (maybe) does `beforeDeath`, and is abandoned. */
async function replaceMidBake(n, beforeDeath) {
  const { root, store } = await setup()
  const k8s = cluster()
  try {
    const a = new Runs(store, k8s, {})
    await a.reconcile()
    await until(() => k8s.streams.length === 1)
    for (const l of k8s.streams[0].backlog.slice(0, n)) k8s.streams[0].write(`${l}\n`)
    await until(async () => (await logLines(store)).length === n)
    await beforeDeath?.(a, k8s.streams[0])
    a.live.get(ID)?.stop() // the old pod dies: its watcher stops, its stream is simply left

    const b = new Runs(store, k8s, {})
    await b.reconcile()
    await until(() => k8s.streams.length === 2)
    for (const l of k8s.streams[1].backlog) k8s.streams[1].write(`${l}\n`)
    await sleep(200)
    b.live.get(ID)?.stop()
    return await logLines(store)
  } finally {
    for (const s of k8s.streams) s.destroy()
    await rm(root, { recursive: true, force: true })
  }
}

const expected = LINES.map((l) => l.slice(l.indexOf(' ') + 1))

test('a pod stopped with SIGTERM hands the next one where the log got to', async () => {
  const got = await replaceMidBake(5, (a) => a.flush())
  assert.deepEqual(got, expected, 'every line exactly once, in order')
})

test('a pod killed without warning still hands over a recent position', async () => {
  // no flush: only the throttled save stands between this and a full replay
  const got = await replaceMidBake(5, async (_a, s) => {
    await sleep(2100)
    s.write(`${LINES[5]}\n`)
    await sleep(100)
  })
  // line 5 was written after the save moved the stamp, so nothing before it may repeat
  assert.deepEqual(got.slice(0, 6), expected.slice(0, 6))
  assert.equal(got.filter((l) => l === 'line 0').length, 1, 'the start of the log was not replayed')
})
