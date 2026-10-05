// `applyCarShine` is the one place a vehicle document's finish becomes a material. It runs on a
// real THREE material and the numbers it writes are what the renderer reads, so the arithmetic is
// worth holding down without a GPU: the defaults are the old glossy paint, a finish replaces them,
// and the tyres and lamps a car is covered in are left alone.

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { injectCarProbe } from '../src/visuals/shading'
import { carProbeGain } from '../src/visuals/carProbe'
import { applyCarShine, CHROME_METALNESS, CHROME_ROUGHNESS, tickShading } from '../src/visuals/shading'
import { TUNE_TABS } from '../src/tuning'

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

  it('a chrome finish is the mirror shorthand and overrides the two sliders', () => {
    const { root, mat } = carBody()
    // the sliders say "matte plastic", chrome wins: it is the one-click version of the pair
    applyCarShine(root, { chrome: true, roughness: 0.9, metalness: 0 })
    expect(mat.roughness).toBeCloseTo(CHROME_ROUGHNESS)
    expect(mat.metalness).toBeCloseTo(CHROME_METALNESS)
    // and it is remembered as the base the global CAR_CHROME dial moves from
    expect(mat.userData.finishRough).toBeCloseTo(CHROME_ROUGHNESS)
    expect(mat.userData.finishMetal).toBeCloseTo(CHROME_METALNESS)
  })

  it('CAR_CHROME pushes the whole fleet to a mirror, and lets go again', () => {
    const { root, mat } = carBody()
    applyCarShine(root)
    const baseR = mat.userData.finishRough as number
    const baseM = mat.userData.finishMetal as number
    const knob = TUNE_TABS.flatMap((t) => t.sections).flatMap((s) => s.keys).find((k) => k.name === 'CAR_CHROME')
    expect(knob, 'CAR_CHROME is a tuning knob').toBeTruthy()
    knob!.set(1)
    tickShading()
    expect(mat.roughness).toBeCloseTo(CHROME_ROUGHNESS)
    expect(mat.metalness).toBeCloseTo(CHROME_METALNESS)
    knob!.set(0)
    tickShading()
    expect(mat.roughness).toBeCloseTo(baseR)
    expect(mat.metalness).toBeCloseTo(baseM)
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

describe('the car reflection probe', () => {
  it('weights the cube by the paint\u2019s own reflectance and the global reflect dial', () => {
    const shader = {
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <opaque_fragment>',
      uniforms: {} as Record<string, { value: unknown }>,
    }
    injectCarProbe(shader)
    // a dielectric reflects ~4% head-on, a metal on the whole face: this is what makes a shiny car
    // read as a mirror square-on instead of only at its edges.
    expect(shader.fragmentShader).toContain('mix(0.04, 1.0, clamp(metalness, 0.0, 1.0))')
    // the global REFLECT dial reaches the probe, not just the sky map it replaces
    expect(shader.uniforms.uCarProbeGain).toBe(carProbeGain)
    expect(shader.vertexShader).toContain('varying vec3 vCarWorld;')
    expect(shader.vertexShader).toContain('vCarWorld = (modelMatrix')
  })

  it('runs the mirror after the clearcoat, so it replaces the coat\u2019s soft sun blob', () => {
    const { root, mat } = carBody()
    applyCarShine(root)
    const shader = {
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <opaque_fragment>',
      uniforms: {} as Record<string, { value: unknown }>,
    }
    mat.onBeforeCompile(shader as never, {} as never)
    const coat = shader.fragmentShader.indexOf('uShine * uCoat')
    const probe = shader.fragmentShader.indexOf('textureCube(uCarProbe')
    expect(coat).toBeGreaterThan(-1)
    expect(probe).toBeGreaterThan(coat)
  })
})
