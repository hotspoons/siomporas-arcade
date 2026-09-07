// Procedural models baked into the sprite atlas alongside the CC0 kits: the
// Group-6-style hero prototype (long nose, fender humps, tail fin), roadside
// architecture (diner, motel, gas station, towers), signs with original
// slogans, arches. Everything is boxes and wedges with flat shading — it only
// ever gets seen as a scaled sprite.

import { BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, SphereGeometry, SRGBColorSpace } from 'three'

export interface Livery {
  body: number
  stripe: number
  number: string
}

export const LIVERIES: Record<string, Livery> = {
  gulf: { body: 0x7fc6e8, stripe: 0xff7a1a, number: '17' },
  rosso: { body: 0xd8262e, stripe: 0xfff2d0, number: '5' },
  martini: { body: 0xf2f2f2, stripe: 0x1a3a9a, number: '22' },
  midnight: { body: 0x1a1c28, stripe: 0xffd45f, number: '8' },
}

interface FlatExtra {
  metalness?: number
  roughness?: number
  emissive?: number
  emissiveIntensity?: number
}
const flat = (color: number, extra: FlatExtra = {}) => {
  const m = new MeshStandardMaterial({ color, flatShading: true, roughness: extra.roughness ?? 0.55, metalness: extra.metalness ?? 0.15 })
  if (extra.emissive !== undefined) {
    m.emissive = new Color(extra.emissive)
    m.emissiveIntensity = extra.emissiveIntensity ?? 1
  }
  return m
}

/** A late-'60s endurance prototype: low, wide, long tail, fender humps, round lamps, fin. Faces +z. */
export function buildPrototype(livery: Livery): Object3D {
  const g = new Group()
  const body = flat(livery.body, { metalness: 0.35, roughness: 0.35 })
  const dark = flat(0x14151a)
  const glass = flat(0x243448, { metalness: 0.8, roughness: 0.2 })
  const stripe = flat(livery.stripe)
  // Main tub.
  g.add(box(3.6, 0.55, 1.95, 0, 0.5, -0.2, body))
  // Long nose sloping down.
  g.add(wedge([[-0.98, 0.25, 1.6], [0.98, 0.25, 1.6], [0.98, 0.78, 0.2], [-0.98, 0.78, 0.2], [-0.98, 0.25, 0.2], [0.98, 0.25, 0.2]], body))
  // Fender humps front and rear.
  for (const z of [1.15, -1.55])
    for (const x of [-0.78, 0.78]) {
      const hump = new Mesh(new SphereGeometry(0.42, 10, 8), body)
      hump.scale.set(1.05, 0.75, 1.35)
      hump.position.set(x, 0.68, z)
      g.add(hump)
    }
  // Canopy: low bubble + windscreen.
  g.add(wedge([[-0.62, 0.78, 0.7], [0.62, 0.78, 0.7], [0.5, 1.22, -0.1], [-0.5, 1.22, -0.1], [-0.55, 0.78, -0.5], [0.55, 0.78, -0.5]], glass))
  g.add(box(1.0, 0.44, 1.0, 0, 1.0, -0.9, body))
  // Tail deck and fin.
  g.add(box(1.9, 0.3, 1.2, 0, 0.9, -1.85, body))
  g.add(box(1.8, 0.06, 0.5, 0, 1.3, -2.2, dark))
  for (const x of [-0.85, 0.85]) g.add(box(0.06, 0.5, 0.7, x, 1.05, -2.1, stripe))
  // Central stripe and roundel.
  g.add(box(0.5, 0.02, 3.4, 0, 0.8, 0, stripe))
  const roundel = new Mesh(new CylinderGeometry(0.28, 0.28, 0.02, 16), flat(0xffffff))
  roundel.rotation.x = Math.PI / 2
  roundel.position.set(0, 0.85, -0.55)
  g.add(roundel)
  const num = textPlane(livery.number, 0.42, '#111', 'transparent', 96)
  num.position.set(0, 0.87, -0.55)
  num.rotation.x = -Math.PI / 2
  g.add(num)
  // Headlamps and tail lamps.
  for (const x of [-0.7, 0.7]) {
    g.add(cyl(0.16, 0.05, x, 0.6, 1.55, flat(0xfff6c8, { emissive: 0xffe0a0, emissiveIntensity: 0.9 })))
    g.add(box(0.28, 0.1, 0.05, x, 0.9, -2.45, flat(0xff2a2a, { emissive: 0xff2a2a, emissiveIntensity: 0.8 })))
  }
  // Wheels (exposed a little), exhausts.
  for (const [x, z] of [[-0.95, 1.1], [0.95, 1.1], [-0.95, -1.5], [0.95, -1.5]]) {
    const w = new Mesh(new CylinderGeometry(0.34, 0.34, 0.32, 12), dark)
    w.rotation.z = Math.PI / 2
    w.position.set(x, 0.34, z)
    g.add(w)
  }
  for (const x of [-0.25, 0.25]) g.add(cyl(0.06, 0.4, x, 0.45, -2.5, dark, true))
  return g
}

export function buildDiner(): Object3D {
  const g = new Group()
  g.add(box(9, 3.2, 6, 0, 1.6, 0, flat(0xe8e0d0)))
  g.add(box(9.4, 0.4, 6.4, 0, 3.4, 0, flat(0xc83838)))
  // Chrome band and windows.
  g.add(box(9.1, 0.3, 6.1, 0, 0.6, 0, flat(0xbfc6d0, { metalness: 0.9, roughness: 0.2 })))
  for (let i = -3; i <= 3; i++) g.add(box(1.0, 1.4, 0.1, i * 1.3, 1.9, 3.05, flat(0x8fd0ff, { emissive: 0x30506a, emissiveIntensity: 0.6 })))
  // Rooftop sign.
  const sign = textPlane('MOTOR DINER', 5.5, '#fff8e0', '#c83838', 128)
  sign.position.set(0, 4.6, 0.6)
  g.add(box(6.0, 1.6, 0.3, 0, 4.6, 0.4, flat(0xc83838)))
  g.add(sign)
  g.add(box(0.2, 1.0, 0.2, -2.5, 3.9, 0.4, flat(0x333)))
  g.add(box(0.2, 1.0, 0.2, 2.5, 3.9, 0.4, flat(0x333)))
  return g
}

export function buildMotel(): Object3D {
  const g = new Group()
  g.add(box(14, 3.0, 5, 0, 1.5, 0, flat(0xd9c9a8)))
  g.add(box(14.4, 0.3, 5.6, 0, 3.15, 0, flat(0x6a4a3a)))
  for (let i = -3; i <= 3; i++) {
    g.add(box(0.9, 1.8, 0.1, i * 1.9, 1.2, 2.55, flat(0x6a3a2a)))
    g.add(box(0.7, 0.7, 0.1, i * 1.9 + 0.95, 2.0, 2.55, flat(0x9fd0ff, { emissive: 0x3a5060, emissiveIntensity: 0.5 })))
  }
  // Tall neon-ish sign on a pole.
  g.add(box(0.25, 6, 0.25, -7.5, 3, 2.6, flat(0x555)))
  g.add(box(3.4, 2.0, 0.3, -7.5, 6.5, 2.6, flat(0x1a3a6a)))
  const s = textPlane('SEA MOTEL', 3.2, '#ffe28a', '#1a3a6a', 128)
  s.position.set(-7.5, 6.5, 2.8)
  g.add(s)
  return g
}

export function buildGasStation(): Object3D {
  const g = new Group()
  g.add(box(6, 2.8, 5, -4, 1.4, -1, flat(0xf0f0f0)))
  g.add(box(12, 0.5, 7, 1, 4.3, 0, flat(0xff7a1a)))
  for (const x of [-2, 4]) for (const z of [-2.6, 2.6]) g.add(box(0.3, 4.1, 0.3, x, 2.05, z, flat(0xdddddd)))
  for (const x of [0.5, 3.5]) g.add(box(0.7, 1.6, 0.5, x, 0.8, 0, flat(0xc83838)))
  const s = textPlane('GAS', 3.5, '#ffffff', '#ff7a1a', 96)
  s.position.set(1, 4.3, 3.55)
  g.add(s)
  return g
}

export function buildTower(h: number, tint: number): Object3D {
  const g = new Group()
  const w = 6 + (h % 3)
  g.add(box(w, h, w, 0, h / 2, 0, flat(tint)))
  const win = flat(0xffe6a0, { emissive: 0xffd080, emissiveIntensity: 1.2 })
  for (let y = 1.5; y < h - 1; y += 2.2)
    for (let x = -w / 2 + 1; x < w / 2; x += 1.6) {
      if (((x * 7 + y * 13) | 0) % 3 === 0) continue
      g.add(box(0.7, 1.0, 0.1, x, y, w / 2 + 0.05, win))
    }
  g.add(box(0.2, 3, 0.2, 0, h + 1.5, 0, flat(0x888)))
  return g
}

export function buildSign(text: string, fg: string, bg: string): Object3D {
  const g = new Group()
  g.add(box(0.3, 4.5, 0.3, -2.6, 2.25, 0, flat(0x777)))
  g.add(box(0.3, 4.5, 0.3, 2.6, 2.25, 0, flat(0x777)))
  g.add(box(6.4, 3.0, 0.2, 0, 5.8, 0, flat(0x333)))
  const s = textPlane(text, 6.0, fg, bg, 160)
  s.position.set(0, 5.8, 0.15)
  g.add(s)
  return g
}

export function buildArch(): Object3D {
  const g = new Group()
  g.add(box(1.2, 9, 1.2, -10.5, 4.5, 0, flat(0x9aa4b0)))
  g.add(box(1.2, 9, 1.2, 10.5, 4.5, 0, flat(0x9aa4b0)))
  g.add(box(22.2, 1.4, 1.4, 0, 9.5, 0, flat(0x4de1ff, { emissive: 0x2090b0, emissiveIntensity: 0.8 })))
  return g
}

// --- helpers ---
function box(w: number, h: number, d: number, x: number, y: number, z: number, m: MeshStandardMaterial): Mesh {
  const b = new Mesh(new BoxGeometry(w, h, d), m)
  b.position.set(x, y, z)
  return b
}
function cyl(r: number, h: number, x: number, y: number, z: number, m: MeshStandardMaterial, alongZ = false): Mesh {
  const c = new Mesh(new CylinderGeometry(r, r, h, 12), m)
  c.rotation.x = alongZ ? Math.PI / 2 : Math.PI / 2
  c.position.set(x, y, z)
  return c
}
/** Six-vertex wedge: bottom quad (0-3) then two ridge/back points; convex enough to be wound outward. */
function wedge(v: number[][], m: MeshStandardMaterial): Mesh {
  const faces = [
    [0, 1, 2], [0, 2, 3], // top slope
    [4, 5, 1], [4, 1, 0], // front lower
    [3, 2, 5], [3, 5, 4], // back
    [0, 3, 4], [1, 5, 2], // sides
  ]
  return new Mesh(fromFaces(v, faces), m)
}
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
/** A plane with text drawn on a canvas, `widthM` metres wide. */
function textPlane(text: string, widthM: number, fg: string, bg: string, px: number): Mesh {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 160
  const g = c.getContext('2d')!
  if (bg !== 'transparent') {
    g.fillStyle = bg
    g.fillRect(0, 0, c.width, c.height)
  }
  g.fillStyle = fg
  g.font = `bold ${px}px Impact, "Arial Black", ui-sans-serif, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, c.width / 2, c.height / 2 + 4)
  const tex = new CanvasTexture(c)
  tex.colorSpace = SRGBColorSpace
  const m = new Mesh(new PlaneGeometry(widthM, widthM * (160 / 512)), new MeshBasicMaterial({ map: tex, transparent: bg === 'transparent', color: new Color(0xffffff) }))
  return m
}
