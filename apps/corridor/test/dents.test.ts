// Dents are memory: a dented mesh wears a private clone of its geometry until it is released.
//
// The DC metro tab passed 5 GB (Rich, 2026-10-07) with four thousand traffic cars and an armed
// player — every car ever knocked kept its clone, and three's renderer holds a drawn geometry until
// that geometry's `dispose` event, so a clone that was merely dropped was never collected. These
// prove a release puts the shared geometry back, fires `dispose` on the clone, and forgets it.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Impact } from '@apex/engine/physics/world'
import { Deformable } from '@apex/engine/physics/deform'
import { dentObject, dentedMeshes, releaseObject, repairObject } from '../src/game/vehicle/dents'

function car(geo: THREE.BufferGeometry) {
  const root = new THREE.Group()
  const body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial())
  root.add(body)
  root.updateMatrixWorld(true)
  return { root, body }
}

function hit(impulse: number): Impact {
  return { a: null!, b: null!, x: 2, y: 0, z: 0, nx: 1, ny: 0, nz: 0, impulse, peak: impulse }
}

describe('dent memory', () => {
  it('a release gives the mesh its shared geometry back and disposes the clone', () => {
    const shared = new THREE.BoxGeometry(4, 1, 2, 8, 4, 4)
    const { body } = car(shared)
    const d = new Deformable(body, { radius: 2, threshold: 100 })
    const clone = body.geometry
    expect(clone).not.toBe(shared)
    let disposed = 0
    clone.addEventListener('dispose', () => disposed++)
    d.apply(hit(20_000))
    d.dispose()
    expect(body.geometry).toBe(shared)
    expect(disposed).toBe(1) // what makes the renderer drop its buffers and its reference
  })

  it('dentObject makes a clone and releaseObject frees it; the count returns to where it was', () => {
    const shared = new THREE.BoxGeometry(4, 1, 2, 8, 4, 4)
    const base = dentedMeshes()
    const cars = Array.from({ length: 5 }, () => car(shared))
    for (const c of cars) expect(dentObject(c.root, hit(50_000), false)).toBe(1)
    expect(dentedMeshes()).toBe(base + 5)
    for (const c of cars) expect(c.body.geometry).not.toBe(shared)
    for (const c of cars) expect(releaseObject(c.root)).toBe(1)
    expect(dentedMeshes()).toBe(base)
    for (const c of cars) expect(c.body.geometry).toBe(shared)
    // a second release finds nothing: the clone is forgotten, not merely straightened
    expect(releaseObject(cars[0].root)).toBe(0)
  })

  it('a repair is a release: the straightened car carries no clone', () => {
    const shared = new THREE.BoxGeometry(4, 1, 2, 8, 4, 4)
    const base = dentedMeshes()
    const { root, body } = car(shared)
    dentObject(root, hit(50_000), false)
    expect(dentedMeshes()).toBe(base + 1)
    expect(repairObject(root)).toBe(1)
    expect(body.geometry).toBe(shared)
    expect(dentedMeshes()).toBe(base)
  })
})
