// Deleting a world removes the definition and the bake. Leaving the site behind would put the
// same slug straight back on the list as a bake with no definition.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Store } from './store.mjs'

async function volume() {
  const root = await mkdtemp(path.join(tmpdir(), 'world-delete-'))
  const store = new Store(root)
  await store.init()
  return { root, store }
}

test('removeWorld drops the definition, the site, and the viewer index entry', async () => {
  const { root, store } = await volume()
  try {
    await store.putWorld({ slug: 'crofton-triangle', lat: 39, lon: -76.6, radius_m: 800 })
    await store.writeAtomic(path.join(store.sites, 'crofton-triangle', 'manifest.json'), Buffer.from('{}'))
    await store.writeAtomic(path.join(store.sites, 'kept', 'manifest.json'), Buffer.from('{}'))
    await store.writeAtomic(
      path.join(store.sites, 'index.json'),
      Buffer.from(JSON.stringify({ sites: [{ slug: 'crofton-triangle' }, { slug: 'kept' }] })),
    )
    assert.deepEqual(await store.removeWorld('crofton-triangle'), { deleted: 'crofton-triangle' })
    assert.equal(await store.getWorld('crofton-triangle'), null)
    assert.equal(existsSync(path.join(store.sites, 'crofton-triangle')), false)
    assert.equal(existsSync(path.join(store.sites, 'kept', 'manifest.json')), true)
    const index = await store.readJson(path.join(store.sites, 'index.json'))
    assert.deepEqual(index.sites.map((s) => s.slug), ['kept'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removeWorld refuses a slug that would walk out of the volume', async () => {
  const { root, store } = await volume()
  try {
    await assert.rejects(store.removeWorld('../secrets'), /not a usable slug/)
    await assert.rejects(store.removeWorld(''), /not a usable slug/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
