// Procedural low-poly sports car: wedge body, cabin, spoiler, four wheels that
// spin with speed and steer at the front, brake lights.

import { BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three'
import type { CarLook } from '../sim/CarSpec'

export class CarMesh {
  readonly root = new Group()
  readonly bodyMaterial: MeshStandardMaterial
  readonly accentMaterial: MeshStandardMaterial
  readonly glassMaterial: MeshStandardMaterial
  private readonly brakeMaterial: MeshBasicMaterial
  private readonly wheels: Group[] = []
  private readonly frontWheels: Group[] = []

  constructor(look: CarLook) {
    this.bodyMaterial = new MeshStandardMaterial({ color: look.body, metalness: 0.4, roughness: 0.35, flatShading: true, emissive: look.body, emissiveIntensity: 0.12 })
    this.accentMaterial = new MeshStandardMaterial({ color: look.accent, metalness: 0.6, roughness: 0.5, flatShading: true })
    this.glassMaterial = new MeshStandardMaterial({ color: look.glass, metalness: 0.9, roughness: 0.15, flatShading: true, emissive: 0x0a1a2a })
    this.brakeMaterial = new MeshBasicMaterial({ color: 0x3a0000 })

    this.root.add(new Mesh(hull(), this.bodyMaterial))
    const cabin = new Mesh(cabinGeo(), this.glassMaterial)
    this.root.add(cabin)
    const skirt = new Mesh(new BoxGeometry(4.3, 0.18, 1.95), this.accentMaterial)
    skirt.position.set(-0.05, 0.12, 0)
    this.root.add(skirt)
    const spoiler = new Mesh(new BoxGeometry(0.35, 0.06, 1.9), this.accentMaterial)
    spoiler.position.set(-2.05, 0.95, 0)
    this.root.add(spoiler)
    for (const z of [-0.7, 0.7]) {
      const strut = new Mesh(new BoxGeometry(0.3, 0.3, 0.08), this.accentMaterial)
      strut.position.set(-2.0, 0.78, z)
      this.root.add(strut)
      const light = new Mesh(new BoxGeometry(0.06, 0.16, 0.5), this.brakeMaterial)
      light.position.set(-2.24, 0.55, z)
      this.root.add(light)
    }
    const tyre = new CylinderGeometry(0.34, 0.34, 0.3, 12).rotateX(Math.PI / 2)
    const rim = new CylinderGeometry(0.2, 0.2, 0.32, 8).rotateX(Math.PI / 2)
    const tyreMat = new MeshStandardMaterial({ color: 0x151515, roughness: 0.9, flatShading: true })
    const rimMat = new MeshStandardMaterial({ color: 0xbfc6d0, metalness: 0.8, roughness: 0.3, flatShading: true })
    for (const [x, z] of [
      [1.35, -0.95],
      [1.35, 0.95],
      [-1.35, -0.95],
      [-1.35, 0.95],
    ]) {
      const g = new Group()
      g.position.set(x, 0.0, z)
      const w = new Group()
      w.add(new Mesh(tyre, tyreMat), new Mesh(rim, rimMat))
      g.add(w)
      this.root.add(g)
      this.wheels.push(w)
      if (x > 0) this.frontWheels.push(g)
    }
  }

  update(wheelSpin: number, steer: number, braking: boolean): void {
    for (const w of this.wheels) w.rotation.z = -wheelSpin
    for (const g of this.frontWheels) g.rotation.y = steer
    this.brakeMaterial.color.set(braking ? 0xff2a2a : 0x3a0000)
  }
}

function hull(): BufferGeometry {
  // x forward, y up, z right. A cab-forward wedge with a flat tail.
  const v = [
    [2.3, 0.25, -0.85],
    [2.3, 0.25, 0.85],
    [2.35, 0.55, -0.7],
    [2.35, 0.55, 0.7],
    [0.6, 0.85, -0.95],
    [0.6, 0.85, 0.95],
    [-2.2, 0.85, -0.95],
    [-2.2, 0.85, 0.95],
    [-2.25, 0.25, -0.95],
    [-2.25, 0.25, 0.95],
    [2.0, 0.1, -0.9],
    [2.0, 0.1, 0.9],
    [-2.1, 0.1, -0.95],
    [-2.1, 0.1, 0.95],
  ]
  const faces = [
    [0, 1, 3], [0, 3, 2], // nose
    [2, 3, 5], [2, 5, 4], // bonnet
    [4, 5, 7], [4, 7, 6], // roof/deck
    [6, 7, 9], [6, 9, 8], // tail
    [0, 2, 4], [0, 4, 6], [0, 6, 8], [0, 8, 10], [10, 8, 12], // left side
    [1, 5, 3], [1, 7, 5], [1, 9, 7], [1, 11, 9], [11, 13, 9], // right side
    [10, 11, 1], [10, 1, 0], // chin
    [12, 13, 11], [12, 11, 10], // floor front
    [8, 9, 13], [8, 13, 12], // floor rear
  ]
  return fromFaces(v, faces)
}

function cabinGeo(): BufferGeometry {
  const v = [
    [0.9, 0.86, -0.75],
    [0.9, 0.86, 0.75],
    [0.1, 1.25, -0.6],
    [0.1, 1.25, 0.6],
    [-1.1, 1.22, -0.62],
    [-1.1, 1.22, 0.62],
    [-1.7, 0.86, -0.78],
    [-1.7, 0.86, 0.78],
  ]
  const faces = [
    [0, 1, 3], [0, 3, 2],
    [2, 3, 5], [2, 5, 4],
    [4, 5, 7], [4, 7, 6],
    [0, 2, 4], [0, 4, 6],
    [1, 5, 3], [1, 7, 5],
  ]
  return fromFaces(v, faces)
}

/** Hand-authored faces, wound outward from the centroid. */
function fromFaces(v: number[][], faces: number[][]): BufferGeometry {
  const c = [0, 0, 0]
  for (const p of v) for (let k = 0; k < 3; k++) c[k] += p[k] / v.length
  const pos = new Float32Array(faces.length * 9)
  let n = 0
  for (const f of faces) {
    const [a, b, d] = [v[f[0]], v[f[1]], v[f[2]]]
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]
    const nx = e1[1] * e2[2] - e1[2] * e2[1]
    const ny = e1[2] * e2[0] - e1[0] * e2[2]
    const nz = e1[0] * e2[1] - e1[1] * e2[0]
    const mx = (a[0] + b[0] + d[0]) / 3 - c[0]
    const my = (a[1] + b[1] + d[1]) / 3 - c[1]
    const mz = (a[2] + b[2] + d[2]) / 3 - c[2]
    const order = nx * mx + ny * my + nz * mz >= 0 ? f : [f[0], f[2], f[1]]
    for (const i of order) {
      pos[n++] = v[i][0]
      pos[n++] = v[i][1]
      pos[n++] = v[i][2]
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}
