// Store.writeAtomic under concurrent writers of ONE file, in one process.
//
// A sharded bake's pod followers each save the run record, so two saves of the same file in the
// same tick are normal. The tmp name used to be per PROCESS, so both writers wrote into one tmp
// file and the survivor was a JSON document with the tail of another after it — or the second
// rename found no tmp left and threw ENOENT out of a log follower. Found by the Docker runner's
// sharded test, which is fast enough to hit it every few runs.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Store } from './store.mjs'

test('concurrent writeAtomic calls to one file all succeed and leave one whole document', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'store-atomic-'))
  try {
    const store = new Store(root)
    const file = path.join(root, 'runs', 'r.json')
    const bodies = Array.from({ length: 40 }, (_, i) => Buffer.from(JSON.stringify({ i, pad: 'x'.repeat((i * 7919) % 5000) })))
    const results = await Promise.allSettled(bodies.map((b) => store.writeAtomic(file, b)))
    assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason.message), [])
    const doc = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(typeof doc.i, 'number')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
