// `applyCarShine` is the one place a vehicle document's finish becomes a material. It runs on a
// real THREE material and the numbers it writes are what the renderer reads, so the arithmetic is
// worth holding down without a GPU: the defaults are the old glossy paint, a finish replaces them,
// and the tyres and lamps a car is covered in are left alone.

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { applyCarShine } from '../src/visuals/shading'

function carBody(props: THREE.MeshStandardMaterialParameters = {}): { root: THREE.Group; mat: THREE.MeshStandardMaterial } {
  const mat = new THREE.MeshStandardMaterial({ color: 0x88331a, roughness: 1, metalness: 0, ...props })
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat)
  const root = new THREE.Group()
  root.add(mesh)
  return { root, mat }
}

describe('the car finish', () => {
  it('floors a rough TRELLIS surface to glossy paint by default', () => {
    const { root, mat } = carBody()
    applyCarShine(root)
    expect(mat.roughness).toBeCloseTo(0.28)
    expect(mat.metalness).toBeCloseTo(0.5)
    // no finish is a multiplier of one, so the global F6 dials still own the car
    expect(mat.userData.finishReflect).toBe(1)
    expect(mat.userData.coat).toBe(1)
  })

  it('lets a document make the paint a mirror', () => {
    const { root, mat } = carBody()
    applyCarShine(root, { roughness: 0.02, metalness: 1, reflect: 2 })
    expect(mat.roughness).toBeCloseTo(0.02)
    expect(mat.metalness).toBeCloseTo(1)
    expect(mat.userData.finishReflect).toBe(2)
  })

  it('never lowers a model that already arrived glossier than the default', () => {
    const { root, mat } = carBody({ roughness: 0.05 })
    applyCarShine(root)
    // the default is a FLOOR, not an assignment
    expect(mat.roughness).toBeCloseTo(0.05)
  })

  it('leaves tyres and lamps out of the coat', () => {
    const tyre = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 })
    const lamp = new THREE.MeshStandardMaterial({ color: 0xfff3d0, emissive: 0xfff0c0, emissiveIntensity: 0.5, roughness: 0.3 })
    const paint = new THREE.MeshStandardMaterial({ color: 0x88331a, roughness: 1 })
    const root = new THREE.Group()
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), tyre))
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), lamp))
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), paint))
    applyCarShine(root)
    expect(tyre.userData.coat).toBeUndefined()
    expect(lamp.userData.coat).toBeUndefined()
    expect(paint.userData.coat).toBe(1)
  })
})
