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

/** Bump when any procedural model changes shape; part of the atlas cache key. */
export const PROCGEN_VERSION = 3

interface Slice {
  z: number
  /** Half width at the widest point. */
  hw: number
  /** Body top height at the centre line. */
  top: number
  /** Extra height at the outer edge — the fender arch swell. */
  bulge: number
  /** Floor height. */
  floor: number
}

/** Half-profile of a slice, from floor-centre up around to top-centre (right side). */
function slicePoints(sl: Slice, n: number): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    // Squarish superellipse: flat floor and top, soft rounded flank.
    const a = t * Math.PI * 0.5
    const x = sl.hw * Math.pow(Math.cos(a), 0.55)
    let y = sl.floor + (sl.top - sl.floor) * Math.pow(Math.sin(a), 1.7)
    // Fender swell: a hump centred ~72 % of the way out, only on the upper half.
    const u = x / Math.max(1e-3, sl.hw)
    y += sl.bulge * Math.exp(-Math.pow((u - 0.7) / 0.24, 2)) * Math.pow(Math.sin(a), 0.8)
    pts.push([x, y])
  }
  return pts
}

/** Loft a closed hull through slices (mirrored left/right), with fan caps at both ends. */
function loft(slices: Slice[], n: number, m: MeshStandardMaterial): Mesh {
  const rings: number[][] = []
  for (const sl of slices) {
    const half = slicePoints(sl, n)
    const ring: number[] = []
    // Right side bottom→top, then left side top→bottom (skip the duplicated centre points).
    for (const [x, y] of half) ring.push(x, y, sl.z)
    for (let i = half.length - 2; i >= 1; i--) ring.push(-half[i][0], half[i][1], sl.z)
    rings.push(ring)
  }
  const per = rings[0].length / 3
  const pos: number[] = []
  const push = (r: number[], i: number) => pos.push(r[i * 3], r[i * 3 + 1], r[i * 3 + 2])
  for (let s = 0; s < rings.length - 1; s++) {
    const a = rings[s]
    const b = rings[s + 1]
    for (let i = 0; i < per; i++) {
      const j = (i + 1) % per
      push(a, i); push(b, i); push(b, j)
      push(a, i); push(b, j); push(a, j)
    }
  }
  // Caps.
  for (const [r, flip] of [[rings[0], false], [rings[rings.length - 1], true]] as const) {
    let cx = 0, cy = 0, cz = 0
    for (let i = 0; i < per; i++) { cx += r[i * 3] / per; cy += r[i * 3 + 1] / per; cz += r[i * 3 + 2] / per }
    for (let i = 0; i < per; i++) {
      const j = (i + 1) % per
      if (flip) { pos.push(cx, cy, cz); push(r, j); push(r, i) }
      else { pos.push(cx, cy, cz); push(r, i); push(r, j) }
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.computeVertexNormals()
  return new Mesh(g, m)
}

/** A late-'60s endurance prototype: lofted low hull with wheel-arch swells, blended canopy, long flat tail. Faces +z. */
export function buildPrototype(livery: Livery): Object3D {
  const g = new Group()
  const body = flat(livery.body, { metalness: 0.35, roughness: 0.3 })
  const dark = flat(0x14151a)
  const glass = flat(0x1e2c40, { metalness: 0.85, roughness: 0.15 })
  const stripe = flat(livery.stripe)
  // Hull: nose → front arches → cockpit → rear arches → tail.
  const hull: Slice[] = [
    // Group 6 proportions: ~2.3 m across the arches and barely 0.9 m to the roof;
    // the centre of the bonnet dives between the two fender swells.
    { z: 2.35, hw: 0.4, top: 0.34, bulge: 0, floor: 0.18 },
    { z: 2.0, hw: 0.82, top: 0.42, bulge: 0.04, floor: 0.14 },
    { z: 1.55, hw: 1.08, top: 0.5, bulge: 0.22, floor: 0.12 },
    { z: 1.15, hw: 1.16, top: 0.54, bulge: 0.32, floor: 0.11 },
    { z: 0.7, hw: 1.12, top: 0.58, bulge: 0.2, floor: 0.11 },
    { z: 0.1, hw: 1.08, top: 0.6, bulge: 0.08, floor: 0.11 },
    { z: -0.6, hw: 1.1, top: 0.62, bulge: 0.12, floor: 0.11 },
    { z: -1.2, hw: 1.16, top: 0.64, bulge: 0.3, floor: 0.11 },
    { z: -1.7, hw: 1.14, top: 0.62, bulge: 0.24, floor: 0.12 },
    { z: -2.3, hw: 1.04, top: 0.56, bulge: 0.06, floor: 0.15 },
    { z: -2.6, hw: 0.96, top: 0.5, bulge: 0, floor: 0.2 },
  ]
  g.add(loft(hull, 7, body))
  // Canopy: a low, wide bubble rising out of the hull top, blended front and back.
  const canopy: Slice[] = [
    { z: 0.95, hw: 0.58, top: 0.6, bulge: 0, floor: 0.5 },
    { z: 0.55, hw: 0.66, top: 0.8, bulge: 0, floor: 0.5 },
    { z: 0.1, hw: 0.7, top: 0.92, bulge: 0, floor: 0.5 },
    { z: -0.5, hw: 0.68, top: 0.9, bulge: 0, floor: 0.5 },
    { z: -1.0, hw: 0.6, top: 0.78, bulge: 0, floor: 0.5 },
    { z: -1.35, hw: 0.5, top: 0.64, bulge: 0, floor: 0.5 },
  ]
  g.add(loft(canopy, 6, glass))
  // Roof spine in body colour over the glass (Group 6 cars had a painted centre section).
  g.add(box(0.4, 0.05, 1.3, 0, 0.92, -0.35, body))
  // Ducktail spoiler: low, wide, integrated on two small fins.
  g.add(box(2.0, 0.05, 0.42, 0, 0.74, -2.45, dark))
  for (const x of [-0.86, 0.86]) g.add(box(0.05, 0.26, 0.5, x, 0.6, -2.4, stripe))
  // Centre stripe: a ribbon lying on the hull top, following its height.
  for (let i = 0; i < hull.length - 1; i++) {
    const a = hull[i]
    const b = hull[i + 1]
    const seg = box(0.34, 0.015, Math.abs(a.z - b.z) + 0.02, 0, (a.top + b.top) / 2 + 0.012, (a.z + b.z) / 2, stripe)
    seg.rotation.x = Math.atan2(a.top - b.top, a.z - b.z)
    if (b.z < 0.95 && b.z > -1.4) seg.visible = false // hidden under the canopy
    g.add(seg)
  }
  // Number roundel on the nose.
  const roundel = new Mesh(new CylinderGeometry(0.27, 0.27, 0.02, 18), flat(0xffffff))
  roundel.position.set(0, 0.5, 1.55)
  roundel.rotation.x = -0.28
  g.add(roundel)
  const num = textPlane(livery.number, 0.4, '#111', 'transparent', 96)
  num.position.set(0, 0.52, 1.55)
  num.rotation.x = -1.29
  g.add(num)
  // Faired headlamps in the fender fronts; tail lamps as slim bars.
  for (const x of [-0.82, 0.82]) {
    const lamp = new Mesh(new SphereGeometry(0.15, 10, 8), flat(0xfff6c8, { emissive: 0xffe0a0, emissiveIntensity: 0.9 }))
    lamp.scale.set(1, 0.7, 0.5)
    lamp.position.set(x, 0.5, 1.9)
    g.add(lamp)
    g.add(box(0.4, 0.09, 0.05, x * 0.95, 0.42, -2.62, flat(0xff2a2a, { emissive: 0xff2a2a, emissiveIntensity: 0.8 })))
  }
  // Intake and exhausts.
  g.add(box(0.6, 0.12, 0.06, 0, 0.28, 2.34, dark))
  for (const x of [-0.22, 0.22]) g.add(cyl(0.055, 0.35, x, 0.3, -2.65, dark, true))
  // Wheels, mostly enclosed by the arches.
  for (const [x, z] of [[-1.0, 1.2], [1.0, 1.2], [-1.0, -1.25], [1.0, -1.25]]) {
    const w = new Mesh(new CylinderGeometry(0.34, 0.34, 0.3, 14), dark)
    w.rotation.z = Math.PI / 2
    w.position.set(x, 0.34, z)
    g.add(w)
    const rim = new Mesh(new CylinderGeometry(0.2, 0.2, 0.32, 8), flat(0xbfc6d0, { metalness: 0.8, roughness: 0.3 }))
    rim.rotation.z = Math.PI / 2
    rim.position.set(x, 0.34, z)
    g.add(rim)
  }
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

/** A downtown mid-rise: a slab with a grid of daytime (unlit) windows and a parapet. */
export function buildBlock(h: number, w: number, tint: number): Object3D {
  const g = new Group()
  g.add(box(w, h, w * 0.8, 0, h / 2, 0, flat(tint)))
  const glass = flat(0x2a3a52, { metalness: 0.2 })
  for (let y = 1.6; y < h - 1.2; y += 2.6)
    for (let x = -w / 2 + 1.2; x < w / 2 - 0.6; x += 2.0) g.add(box(1.2, 1.4, 0.1, x, y, (w * 0.8) / 2 + 0.05, glass))
  g.add(box(w + 0.4, 0.5, w * 0.8 + 0.4, 0, h + 0.2, 0, flat(0x6a6a70)))
  g.add(box(2.4, 2.2, 2.4, w / 4, h + 1.5, 0, flat(0x7a7a80)))
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
