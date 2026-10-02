// Finished runs can leave the history. A run that is still going cannot.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Runs } from './runs.mjs'
import { Store } from './store.mjs'

async function volume() {
  const root = await mkdtemp(path.join(tmpdir(), 'runs-delete-'))
  const store = new Store(root)
  await store.init()
  return { root, store }
}

async function put(store, id, state) {
  const run = { id, label: id, state, started: '2026-10-01T00:00:00.000Z', finished: state === 'running' ? null : '2026-10-01T01:00:00.000Z' }
  await store.writeAtomic(store.runFile(id), Buffer.from(JSON.stringify(run)))
  await store.writeAtomic(store.logFile(id), Buffer.from('log\n'))
}

test('remove drops a finished run and its log, and refuses one that is still going', async () => {
  const { root, store } = await volume()
  try {
    await put(store, 'done-1', 'done')
    await put(store, 'live-1', 'running')
    const runs = new Runs(store, { available: false }, {})
    assert.deepEqual(await runs.remove('done-1'), { deleted: 'done-1' })
    assert.equal(await runs.get('done-1'), null)
    assert.equal(await store.readJson(store.logFile('done-1')), null)
    await assert.rejects(runs.remove('live-1'), /still running/)
    assert.equal((await runs.get('live-1')).state, 'running')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('clearFinished removes the history and leaves a live run', async () => {
  const { root, store } = await volume()
  try {
    await put(store, 'done-1', 'done')
    await put(store, 'fail-1', 'failed')
    await put(store, 'live-1', 'running')
    const runs = new Runs(store, { available: false }, {})
    assert.deepEqual(await runs.clearFinished(), { deleted: 2, kept: 1 })
    const left = await runs.list(10)
    assert.deepEqual(left.map((r) => r.id), ['live-1'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
