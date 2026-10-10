// facades.mjs is a copy of the app's layering (src/world/facades.ts `resolveFacades`), for the MCP
// tools. These are the app test's cases (apps/corridor/test/facades.test.ts, "three layers"), so a
// change to one that is not made to the other fails here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { builtinFacades, checkPatch, facadeSources, resolveFacades } from './facades.mjs'

test('built-in, then the shared default, then the world — per field', async () => {
  const B = await builtinFacades()
  const shared = [{ id: 'apartments', walls: [{ material: 'cmu_bare', weight: 1 }], metalness: 0.2 }]
  const world = { classes: { apartments: { metalness: 0.5 } } }
  const apt = resolveFacades(B, shared, world).find((c) => c.id === 'apartments')
  assert.deepEqual(apt.walls, [{ material: 'cmu_bare', weight: 1 }])
  assert.equal(apt.metalness, 0.5)
  assert.equal(apt.roughness, B.find((c) => c.id === 'apartments').roughness)
  assert.deepEqual(facadeSources('apartments', shared, world), { walls: 'shared', roofs: 'built-in', metalness: 'world', roughness: 'built-in', glass: 'built-in' })
})

test('the world’s single pool beats the shared default and loses to its own class pools', async () => {
  const B = await builtinFacades()
  const world = { walls: ['stucco_cream'], classes: { house: { walls: [{ material: 'fieldstone', weight: 1 }] } } }
  const out = resolveFacades(B, [{ id: 'commercial', walls: [{ material: 'cmu_bare', weight: 1 }] }], world)
  assert.deepEqual(out.find((c) => c.id === 'commercial').walls, [{ material: 'stucco_cream', weight: 1 }])
  assert.deepEqual(out.find((c) => c.id === 'house').walls, [{ material: 'fieldstone', weight: 1 }])
})

test('clamps and cleans what a record says', async () => {
  const B = await builtinFacades()
  const h = resolveFacades(B, [{ id: 'house', metalness: 7, walls: [{ material: '', weight: 1 }, { material: 'x', weight: -1 }, { material: 'y', weight: 2 }] }], null).find((c) => c.id === 'house')
  assert.equal(h.metalness, 1)
  assert.deepEqual(h.walls, [{ material: 'y', weight: 2 }])
})

test('checkPatch keeps known fields and refuses the rest with what to do', () => {
  assert.deepEqual(checkPatch({ metalness: 0.4, glass: 1, colour: 'red' }, null), { metalness: 0.4, glass: true })
  assert.throws(() => checkPatch({ walls: 'brick' }, null), /list of/)
  assert.throws(() => checkPatch({ roofs: [{ material: 'zinc', weight: 1 }] }, new Set(['slate'])), /not in the library: zinc/)
})
