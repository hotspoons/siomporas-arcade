// Every mode's things in every mode, the active one bolder (Rich, 2026-10-10). The emphasis pass
// scales what a mode drew without the mode knowing — so it has to notice when the mode redraws.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { applyEmphasis, HANDLE, PASSIVE_OPACITY, PASSIVE_WIDTH } from '../src/editor/view/emphasis'

function layer() {
  const g = new THREE.Group()
  const fillMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3 })
  const fill = new THREE.Mesh(new THREE.BufferGeometry(), fillMat)
  const lineMat = new LineMaterial({ linewidth: 3, transparent: true, opacity: 0.95 })
  const line = new THREE.Mesh(new THREE.BufferGeometry(), lineMat)
  const postMat = new THREE.MeshBasicMaterial({ color: 0xffd54f })
  const post = new THREE.Mesh(new THREE.BufferGeometry(), postMat)
  const handle = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  handle.name = HANDLE
  const worldMat = new THREE.MeshStandardMaterial({ transparent: false, opacity: 1 })
  const world = new THREE.Mesh(new THREE.BufferGeometry(), worldMat)
  const keptMat = new THREE.MeshBasicMaterial({ opacity: 1 })
  const kept = new THREE.Group()
  kept.userData.emphasisKeep = true
  kept.add(new THREE.Mesh(new THREE.BufferGeometry(), keptMat))
  g.add(fill, line, post, handle, world, kept)
  return { g, fillMat, lineMat, postMat, handle, worldMat, keptMat }
}

describe('applyEmphasis', () => {
  it('passive: marks at about half strength, outlines thinner, no handles; active puts it all back', () => {
    const l = layer()
    applyEmphasis(l.g, 'passive')
    expect(l.fillMat.opacity).toBeCloseTo(0.3 * PASSIVE_OPACITY)
    expect(l.lineMat.linewidth).toBeCloseTo(3 * PASSIVE_WIDTH)
    expect(l.postMat.transparent).toBe(true)
    expect(l.postMat.opacity).toBeCloseTo(PASSIVE_OPACITY)
    expect(l.handle.visible).toBe(false)
    applyEmphasis(l.g, 'active')
    expect(l.fillMat.opacity).toBeCloseTo(0.3)
    expect(l.lineMat.linewidth).toBeCloseTo(3)
    expect(l.postMat.transparent).toBe(false)
    expect(l.postMat.opacity).toBe(1)
    expect(l.handle.visible).toBe(true)
  })
  it('is idempotent: a second pass at the same emphasis changes nothing', () => {
    const l = layer()
    applyEmphasis(l.g, 'passive')
    applyEmphasis(l.g, 'passive')
    expect(l.fillMat.opacity).toBeCloseTo(0.3 * PASSIVE_OPACITY)
  })
  it('a mode that rewrites its colours while passive (a selection, a reload) is quietened from its new value', () => {
    const l = layer()
    applyEmphasis(l.g, 'passive')
    l.fillMat.opacity = 0.45 // the zone was selected from the list: its mode drew it brighter
    applyEmphasis(l.g, 'passive')
    expect(l.fillMat.opacity).toBeCloseTo(0.45 * PASSIVE_OPACITY)
    applyEmphasis(l.g, 'active')
    expect(l.fillMat.opacity).toBeCloseTo(0.45)
  })
  it('leaves the world alone: lit materials, and anything under emphasisKeep', () => {
    const l = layer()
    applyEmphasis(l.g, 'passive')
    expect(l.worldMat.opacity).toBe(1)
    expect(l.worldMat.transparent).toBe(false)
    expect(l.keptMat.opacity).toBe(1)
  })
})
