// Which drawing TRELLIS meshes, and what deleting one does to that.
//
// Rich, 2026-09-30: "I can't select which photo to send to the trellis mesher, the first image
// stays put and there is no way to change it or delete it."
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Catalog } from './catalog.mjs'

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const tick = () => new Promise((r) => setTimeout(r, 2)) // view names are millisecond stamps

async function withItem(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'catalog-'))
  try {
    const c = new Catalog(root)
    await c.put('car', { subject: 'car', prompt: 'a car' })
    await fn(c)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const draw = async (c) => { await tick(); return c.addView('car', PNG, { step: 'image' }) }

test('the newest drawing is the one meshed, until a person picks one', () =>
  withItem(async (c) => {
    const a = await draw(c)
    assert.equal((await c.get('car')).chosen, a)
    const b = await draw(c)
    // the bug: the first stayed chosen for ever
    assert.equal((await c.get('car')).chosen, b)
  }))

test('a person\'s pick survives later drawings', () =>
  withItem(async (c) => {
    const a = await draw(c)
    await draw(c)
    await c.put('car', { chosen: a, chosenBy: 'person' })
    await draw(c)
    assert.equal((await c.get('car')).chosen, a)
  }))

test('deleting a drawing removes it, and the others stay', () =>
  withItem(async (c) => {
    const a = await draw(c)
    const b = await draw(c)
    await c.put('car', { chosen: b, chosenBy: 'person' })
    const after = await c.removeView('car', a)
    assert.deepEqual(after.views, [b])
    assert.equal(after.chosen, b)
    assert.equal(after.history.at(-1).step, 'remove-view')
  }))

test('deleting the chosen one hands the choice to the newest left, as a default', () =>
  withItem(async (c) => {
    const a = await draw(c)
    const b = await draw(c)
    const d = await draw(c)
    await c.put('car', { chosen: b, chosenBy: 'person' })
    const after = await c.removeView('car', b)
    assert.equal(after.chosen, d)
    assert.equal(after.chosenBy, 'draw')
    assert.deepEqual(after.views, [a, d])
  }))

test('deleting the last drawing leaves nothing chosen, not a missing file', () =>
  withItem(async (c) => {
    const a = await draw(c)
    const after = await c.removeView('car', a)
    assert.deepEqual(after.views, [])
    assert.equal(after.chosen, null)
  }))

test('a view that is not the item\'s is refused, not resolved as a path', () =>
  withItem(async (c) => {
    await draw(c)
    for (const bad of ['../item.json', 'nope.png', '']) {
      await assert.rejects(c.removeView('car', bad), (e) => e.status === 404)
    }
    assert.ok((await c.get('car')).prompt, 'item.json survived')
  }))
