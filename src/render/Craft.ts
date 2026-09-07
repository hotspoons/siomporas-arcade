// The player's craft: a low-slung rocket bike — a rider crouched over a tank
// in a liter-bike tuck, wrapped in an angular red spaceship body, with a
// second seat behind, twin roof cannons, and shield plates bolted to the
// flanks that dim and flicker as the shield drains. Inspired, not copied.

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three'

const RED = 0xd8262e
const DARK = 0x232833
const PLATE = 0x2c9fd9

export class Craft {
  readonly root = new Group()
  readonly bodyMaterial: MeshStandardMaterial
  readonly darkMaterial: MeshStandardMaterial
  readonly plateMaterial: MeshStandardMaterial
  readonly accentMaterial: MeshBasicMaterial
  readonly engineMaterial: MeshBasicMaterial
  readonly engine: Group
  readonly shadow: Mesh
  private readonly halo: Mesh
  private readonly plates: Mesh[] = []
  private readonly plateColor = new Color(PLATE)
  private readonly plateLow = new Color(0xff3b5c)
  private time = 0

  constructor() {
    this.bodyMaterial = new MeshStandardMaterial({ color: RED, metalness: 0.15, roughness: 0.45, emissive: 0x8c1219, emissiveIntensity: 1.1, flatShading: true })
    this.darkMaterial = new MeshStandardMaterial({ color: DARK, metalness: 0.4, roughness: 0.6, emissive: 0x151a24, emissiveIntensity: 0.8, flatShading: true })
    this.plateMaterial = new MeshStandardMaterial({ color: PLATE, metalness: 0.3, roughness: 0.3, emissive: PLATE, emissiveIntensity: 0.9, transparent: true, opacity: 0.9, flatShading: true })
    this.accentMaterial = new MeshBasicMaterial({ color: 0x25e8ff })
    this.engineMaterial = new MeshBasicMaterial({ color: 0xff8a3c, side: DoubleSide })

    // Hull: nose wedge, flared mid-body, tail with a fin.
    this.root.add(new Mesh(buildHull(), this.bodyMaterial))
    this.root.add(new Mesh(buildUnderbody(), this.darkMaterial))

    // Tank between the rider's knees, and the rider: helmet, shoulders, torso leaning in.
    const tank = new Mesh(new BoxGeometry(0.9, 0.55, 1.5), this.bodyMaterial)
    tank.position.set(0, 0.85, 0.5)
    this.root.add(tank)
    const torso = new Mesh(new BoxGeometry(0.8, 0.5, 1.3), this.darkMaterial)
    torso.position.set(0, 1.15, -0.35)
    torso.rotation.x = 0.45
    this.root.add(torso)
    const helmet = new Mesh(new IcosahedronGeometry(0.36, 1), this.plateMaterial)
    helmet.position.set(0, 1.42, 0.35)
    this.root.add(helmet)
    for (const x of [-0.55, 0.55]) {
      const shoulder = new Mesh(new BoxGeometry(0.3, 0.3, 0.9), this.darkMaterial)
      shoulder.position.set(x, 1.05, 0.05)
      shoulder.rotation.x = 0.5
      this.root.add(shoulder)
    }
    // Second seat behind the rider, with a low backrest.
    const seat = new Mesh(new BoxGeometry(0.85, 0.3, 0.9), this.darkMaterial)
    seat.position.set(0, 0.95, -1.6)
    this.root.add(seat)
    const backrest = new Mesh(new BoxGeometry(0.85, 0.7, 0.2), this.bodyMaterial)
    backrest.position.set(0, 1.25, -2.1)
    backrest.rotation.x = -0.2
    this.root.add(backrest)
    // Twin cannons on a roof arch over the rider.
    const arch = new Mesh(new BoxGeometry(1.6, 0.14, 0.5), this.darkMaterial)
    arch.position.set(0, 1.75, -0.9)
    this.root.add(arch)
    for (const x of [-0.6, 0.6]) {
      const barrel = new Mesh(new BoxGeometry(0.16, 0.16, 2.4), this.darkMaterial)
      barrel.position.set(x, 1.85, 0.2)
      this.root.add(barrel)
      const tip = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), this.accentMaterial)
      tip.position.set(x, 1.85, 1.45)
      this.root.add(tip)
    }
    // Shield plates: angled slabs on each flank plus a canopy plate over the seats.
    for (const side of [-1, 1]) {
      const plate = new Mesh(new BoxGeometry(0.12, 1.1, 3.4), this.plateMaterial)
      plate.position.set(side * 1.75, 0.55, -0.6)
      plate.rotation.z = side * 0.28
      this.root.add(plate)
      this.plates.push(plate)
    }
    const canopy = new Mesh(new BoxGeometry(1.4, 0.1, 1.4), this.plateMaterial)
    canopy.position.set(0, 1.95, -1.6)
    this.root.add(canopy)
    this.plates.push(canopy)
    // Leading-edge trim.
    this.root.add(new Mesh(buildTrim(), this.accentMaterial))

    // Twin exhausts: small hot discs plus a soft additive halo behind them.
    this.engine = new Group()
    const disc = new CircleGeometry(0.3, 10)
    for (const x of [-0.6, 0.6]) {
      const m = new Mesh(disc, this.engineMaterial)
      m.position.set(x, 0.1, -3.45)
      this.engine.add(m)
    }
    this.halo = new Mesh(new PlaneGeometry(2.8, 1.5), new MeshBasicMaterial({ map: radialGlow(), color: 0xff8a3c, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }))
    this.halo.position.set(0, 0.1, -3.8)
    this.engine.add(this.halo)
    this.root.add(this.engine)

    this.shadow = new Mesh(new PlaneGeometry(4.6, 8), new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }))
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

  /** Shield plates fade with the shield and flicker red when it is nearly gone. */
  setShield(frac: number, dt: number): void {
    this.time += dt
    const low = frac < 0.35
    const flicker = low ? 0.55 + 0.45 * Math.abs(Math.sin(this.time * 18)) : 1
    const m = this.plateMaterial
    m.emissive.copy(low ? this.plateLow : this.plateColor)
    m.emissiveIntensity = (0.25 + 0.9 * frac) * flicker
    m.opacity = 0.35 + 0.6 * frac
    for (const p of this.plates) p.visible = frac > 0.02
  }

  setTint(color: Color): void {
    this.accentMaterial.color.copy(color)
  }

  /** Materials the ghost makes translucent. */
  get materials(): MeshStandardMaterial[] {
    return [this.bodyMaterial, this.darkMaterial, this.plateMaterial]
  }
}

function buildHull(): BufferGeometry {
  // Angular red shell: sharp nose, flared shoulders over the rider, tapered tail, fin.
  const v = [
    [0, 0.35, 3.8], // 0 nose tip
    [-1.35, 0.1, 1.2], // 1 left shoulder front
    [1.35, 0.1, 1.2], // 2 right shoulder front
    [-1.5, 0.15, -0.8], // 3 left flank
    [1.5, 0.15, -0.8], // 4 right flank
    [-0.9, 0.3, -3.3], // 5 tail left
    [0.9, 0.3, -3.3], // 6 tail right
    [0, 0.75, 1.6], // 7 spine front (in front of the tank)
    [0, 0.6, -2.6], // 8 spine tail
    [0, 1.9, -2.9], // 9 fin top
    [0, 0.6, -3.4], // 10 fin trailing
    [-0.6, 0.55, -1.1], // 11 left seat rail
    [0.6, 0.55, -1.1], // 12 right seat rail
  ]
  const faces = [
    [0, 1, 7],
    [0, 7, 2],
    [1, 3, 11],
    [1, 11, 7],
    [2, 7, 12],
    [2, 12, 4],
    [3, 5, 8],
    [3, 8, 11],
    [4, 12, 8],
    [4, 8, 6],
    [11, 8, 12],
    [7, 11, 12],
    [8, 9, 10],
    [8, 10, 9],
    [5, 10, 8],
    [6, 8, 10],
  ]
  return fromFaces(v, faces)
}

function buildUnderbody(): BufferGeometry {
  const v = [
    [0, 0.35, 3.8],
    [-1.35, 0.1, 1.2],
    [1.35, 0.1, 1.2],
    [-1.5, 0.15, -0.8],
    [1.5, 0.15, -0.8],
    [-0.9, 0.3, -3.3],
    [0.9, 0.3, -3.3],
    [0, -0.55, 1.0], // 7 keel front
    [0, -0.6, -2.6], // 8 keel tail
  ]
  const faces = [
    [0, 7, 1],
    [0, 2, 7],
    [1, 7, 3],
    [2, 4, 7],
    [3, 7, 8],
    [4, 8, 7],
    [3, 8, 5],
    [4, 6, 8],
    [5, 8, 6],
  ]
  return fromFaces(v, faces)
}

function buildTrim(): BufferGeometry {
  const v = [
    [-1.35, 0.12, 1.2],
    [-0.1, 0.36, 3.6],
    [-0.02, 0.3, 3.7],
    [-1.25, 0.05, 1.15],
    [1.35, 0.12, 1.2],
    [0.1, 0.36, 3.6],
    [0.02, 0.3, 3.7],
    [1.25, 0.05, 1.15],
  ]
  const faces = [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
  ]
  return fromFaces(v, faces)
}

/** Hand-authored faces, wound so every normal points away from the hull's centroid. */
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
