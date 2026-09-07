// The player's craft: a low-slung procedural wedge with a roof-mounted laser
// mount, engine glow and a soft ground shadow. Built once from typed arrays.

import { AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, DoubleSide } from 'three'

export class Craft {
  readonly root = new Group()
  readonly body: Mesh
  readonly engine: Group
  private readonly halo: Mesh
  readonly shadow: Mesh
  readonly bodyMaterial: MeshStandardMaterial
  readonly engineMaterial: MeshBasicMaterial
  readonly accentMaterial: MeshBasicMaterial

  constructor() {
    this.bodyMaterial = new MeshStandardMaterial({ color: 0xc9d4ee, metalness: 0.25, roughness: 0.45, emissive: 0x24386e, emissiveIntensity: 1.0, flatShading: true })
    this.accentMaterial = new MeshBasicMaterial({ color: 0x25e8ff })
    this.engineMaterial = new MeshBasicMaterial({ color: 0xff8a3c, side: DoubleSide })
    this.body = new Mesh(buildHull(), this.bodyMaterial)
    this.root.add(this.body)
    const accents = new Mesh(buildAccents(), this.accentMaterial)
    this.root.add(accents)
    // Twin exhausts: small hot discs plus a soft additive halo behind them.
    this.engine = new Group()
    const disc = new CircleGeometry(0.3, 10)
    for (const x of [-0.5, 0.5]) {
      const m = new Mesh(disc, this.engineMaterial)
      m.position.set(x, 0.05, -3.28)
      this.engine.add(m)
    }
    this.halo = new Mesh(new PlaneGeometry(2.6, 1.4), new MeshBasicMaterial({ map: radialGlow(), color: 0xff8a3c, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }))
    this.halo.position.set(0, 0.05, -3.6)
    this.engine.add(this.halo)
    this.root.add(this.engine)
    this.shadow = new Mesh(new PlaneGeometry(4.2, 7.5), new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }))
    this.shadow.rotation.x = -Math.PI / 2
    this.shadow.position.y = -0.85
    this.root.add(this.shadow)
  }

  setEngine(intensity: number, boost: boolean): void {
    const m = this.engineMaterial
    m.color.setHSL(boost ? 0.9 : 0.07, 1, 0.5 + 0.2 * intensity)
    ;(this.halo.material as MeshBasicMaterial).color.copy(m.color)
    ;(this.halo.material as MeshBasicMaterial).opacity = 0.25 + 0.45 * intensity
    this.halo.scale.set(0.8 + intensity * 0.6, 0.8 + intensity * 0.8, 1)
  }

  setTint(color: Color): void {
    this.accentMaterial.color.copy(color)
  }
}

function buildHull(): BufferGeometry {
  // Wedge: nose at +z, tail at -z, belly flat, roof faceted.
  const v = [
    [0, 0.2, 3.4], // 0 nose
    [-1.6, -0.2, -0.6], // 1 left wing tip
    [1.6, -0.2, -0.6], // 2 right wing tip
    [-0.9, -0.35, -3.2], // 3 tail left bottom
    [0.9, -0.35, -3.2], // 4 tail right bottom
    [0, 1.05, -1.4], // 5 roof peak
    [-0.7, 0.55, -3.1], // 6 tail left top
    [0.7, 0.55, -3.1], // 7 tail right top
    [0, -0.4, 0.4], // 8 belly keel
  ]
  const faces = [
    [0, 1, 5],
    [0, 5, 2],
    [1, 6, 5],
    [2, 5, 7],
    [5, 6, 7],
    [1, 3, 6],
    [2, 7, 4],
    [3, 4, 7],
    [3, 7, 6],
    [0, 8, 1],
    [0, 2, 8],
    [8, 2, 4],
    [8, 4, 3],
    [8, 3, 1],
  ]
  return fromFaces(v, faces)
}

function buildAccents(): BufferGeometry {
  // Two glowing leading-edge slats and the laser mount on the roof.
  const v = [
    [-1.55, -0.1, -0.5],
    [-0.3, 0.15, 2.6],
    [-0.15, 0.05, 2.7],
    [-1.4, -0.2, -0.4],
    [1.55, -0.1, -0.5],
    [0.3, 0.15, 2.6],
    [0.15, 0.05, 2.7],
    [1.4, -0.2, -0.4],
    // tail trim: trailing edges of both wings and the fin
    [-1.6, -0.15, -0.7],
    [-0.9, -0.3, -3.25],
    [-0.9, -0.15, -3.25],
    [1.6, -0.15, -0.7],
    [0.9, -0.3, -3.25],
    [0.9, -0.15, -3.25],
    [0, 1.1, -1.5],
    [0.06, 0.6, -3.15],
    [-0.06, 0.6, -3.15],
    // laser mount box
    [-0.18, 1.05, -1.0],
    [0.18, 1.05, -1.0],
    [0.18, 1.35, -1.9],
    [-0.18, 1.35, -1.9],
    [-0.18, 1.35, -0.4],
    [0.18, 1.35, -0.4],
  ]
  const faces = [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
    [8, 9, 10],
    [11, 13, 12],
    [14, 15, 16],
    [17, 18, 22],
    [17, 22, 21],
    [21, 22, 19],
    [21, 19, 20],
    [17, 21, 20],
    [18, 19, 22],
  ]
  return fromFaces(v, faces)
}

function fromFaces(v: number[][], faces: number[][]): BufferGeometry {
  const pos = new Float32Array(faces.length * 9)
  let n = 0
  for (const f of faces) {
    for (const i of f) {
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

/** Soft radial falloff texture shared by glow sprites. */
export function radialGlow(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return new CanvasTexture(c)
}
