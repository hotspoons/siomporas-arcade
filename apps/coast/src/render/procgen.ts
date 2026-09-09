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
export const PROCGEN_VERSION = 14

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
  // Hull: a 1970 sports prototype — 917 K, 512 S, 908/3, 330 P4. What makes those cars read at a
  // glance is not detail, it is the section: a nose that dives almost to the road and stays *low* all
  // the way to the screen, with the fenders standing well proud of it in two long crowns, and a tail
  // chopped off short. Modern prototypes are the opposite — a high flat deck with a wing over it —
  // which is what this car used to look like.
  const hull: Slice[] = [
    { z: 2.3, hw: 0.5, top: 0.26, bulge: 0.02, floor: 0.12 },
    { z: 2.0, hw: 0.84, top: 0.28, bulge: 0.12, floor: 0.1 },
    { z: 1.7, hw: 1.0, top: 0.3, bulge: 0.3, floor: 0.09 },
    { z: 1.3, hw: 1.06, top: 0.32, bulge: 0.34, floor: 0.09 },
    { z: 0.95, hw: 1.02, top: 0.4, bulge: 0.22, floor: 0.09 },
    { z: 0.5, hw: 0.98, top: 0.52, bulge: 0.08, floor: 0.1 },
    { z: 0.0, hw: 0.98, top: 0.54, bulge: 0.1, floor: 0.1 },
    // Haunches: the rear arches swell up and out well past the deck between them, which is the line
    // every one of these cars has and the thing that reads first from behind.
    { z: -0.6, hw: 1.02, top: 0.5, bulge: 0.26, floor: 0.1 },
    { z: -1.15, hw: 1.22, top: 0.46, bulge: 0.52, floor: 0.1 },
    { z: -1.7, hw: 1.22, top: 0.44, bulge: 0.5, floor: 0.11 },
    { z: -2.15, hw: 1.06, top: 0.44, bulge: 0.18, floor: 0.14 },
    { z: -2.4, hw: 0.86, top: 0.42, bulge: 0.02, floor: 0.18 },
  ]
  g.add(loft(hull, 7, body))
  // Canopy: small and set well back, a bubble sitting between the fender crowns rather than a
  // greenhouse spanning the car. The screen rakes hard and the roof is barely over a metre up.
  const canopy: Slice[] = [
    { z: 0.9, hw: 0.42, top: 0.5, bulge: 0, floor: 0.42 },
    { z: 0.55, hw: 0.54, top: 0.72, bulge: 0, floor: 0.45 },
    { z: 0.1, hw: 0.6, top: 0.84, bulge: 0, floor: 0.45 },
    { z: -0.3, hw: 0.58, top: 0.82, bulge: 0, floor: 0.45 },
  ]
  g.add(loft(canopy, 6, glass))
  // Flying buttresses and a near-vertical rear window between them: the roof does not just fade into
  // the deck on these cars, it runs back as two fins that land on the haunches with the glass sunk
  // between. It is the shape you see in every three-quarter shot of a P4 or a 512.
  for (const side of [-1, 1]) {
    // Narrow at the roof, wide at the haunch: a buttress leaves the top of the dome and sweeps *out*
    // and down as it goes back. Angled the other way it reads as a pair of wings stuck on the deck.
    // Its front sits *at* the roofline, never above it: standing proud they read as fins, and the
    // roof has to run into them for the cabin to look like one piece with the tail.
    const flank = box(0.12, 0.26, 1.4, side * 0.56, 0.62, -0.95, body)
    flank.rotation.x = -0.12
    flank.rotation.y = -side * 0.2
    g.add(flank)
  }
  // The window between them is small and steep. A big dark pane across the back reads as a hole in
  // the car from behind, which is exactly what it looked like before.
  const rear = box(0.62, 0.3, 0.04, 0, 0.72, -0.62, glass)
  rear.rotation.x = 0.3
  g.add(rear)
  // The dome does not stop at the glass: it runs back between the buttresses as a raised centre
  // section, drops sharply at the end of it, and the flat deck carries on to the tail between the
  // haunches. That step is the shape you see in every rear-three-quarter photograph of a 512 S.
  g.add(box(1.02, 0.06, 1.15, 0, 0.5, -1.7, body))
  // Engine bay louvres either side of the drop, in the deck.
  for (const side of [-1, 1]) g.add(box(0.34, 0.03, 0.5, side * 0.52, 0.54, -1.5, dark))
  // The painted part of the dome: it picks up where the glass stops and carries the same section back
  // between the buttresses before dropping to the deck. As a flat plate laid on the roof it read as a
  // plank; as a continuation of the dome it reads as one piece of bodywork, which is what it is.
  const dome: Slice[] = [
    { z: 0.2, hw: 0.58, top: 0.84, bulge: 0, floor: 0.5 },
    { z: -0.35, hw: 0.57, top: 0.83, bulge: 0, floor: 0.5 },
    { z: -0.85, hw: 0.52, top: 0.79, bulge: 0, floor: 0.5 },
    { z: -1.3, hw: 0.44, top: 0.72, bulge: 0, floor: 0.5 },
  ]
  g.add(loft(dome, 6, body))
  // The roll hoop behind the glass.
  g.add(box(0.74, 0.05, 0.07, 0, 0.76, -0.28, dark))
  // Tail: a Kurzheck lip across the cut-off deck with a small fin at each corner — no wing. A wing on
  // struts is the single thing that makes a car read as modern, and these cars did not have one.
  g.add(box(1.9, 0.06, 0.28, 0, 0.56, -2.26, body))
  // Nothing standing up off the tail: the corner fins read as two black slabs at sprite size, and a
  // P4 or a 512 does not have them anyway. The haunches carry the shape instead.
  g.add(box(1.5, 0.04, 0.12, 0, 0.59, -2.16, stripe))
  // Centre stripe: a ribbon lying on the hull top, following its height.
  for (let i = 0; i < hull.length - 1; i++) {
    const a = hull[i]
    const b = hull[i + 1]
    const seg = box(0.34, 0.015, Math.abs(a.z - b.z) + 0.02, 0, (a.top + b.top) / 2 + 0.012, (a.z + b.z) / 2, stripe)
    seg.rotation.x = Math.atan2(a.top - b.top, a.z - b.z)
    if (b.z < 0.95 && b.z > -1.4) seg.visible = false // hidden under the canopy
    g.add(seg)
  }
  // Number roundel: a white disc on the door, where a period sports car carried it, rather than lying
  // flat on the bonnet — it is what you see of the number from the side.
  for (const side of [-1, 1]) {
    // A racing roundel is about the size of a door, not bigger than one.
    const roundel = new Mesh(new CylinderGeometry(0.19, 0.19, 0.02, 18), flat(0xffffff))
    roundel.rotation.z = Math.PI / 2
    roundel.position.set(side * 1.0, 0.42, 0.3)
    g.add(roundel)
    const num = textPlane(livery.number, 0.26, '#111', 'transparent', 96)
    num.position.set(side * 1.02, 0.42, 0.3)
    num.rotation.y = (side * Math.PI) / 2
    g.add(num)
  }
  // Faired headlamps sunk into the fender crowns, under perspex; tail lamps as small round pods.
  for (const x of [-0.78, 0.78]) {
    const lamp = new Mesh(new SphereGeometry(0.16, 10, 8), flat(0xfff6c8, { emissive: 0xffe0a0, emissiveIntensity: 0.9 }))
    lamp.scale.set(1, 0.6, 0.55)
    lamp.position.set(x, 0.44, 1.82)
    g.add(lamp)
    for (const dx of [-0.16, 0.16]) {
      const tail = new Mesh(new CylinderGeometry(0.075, 0.075, 0.05, 10), flat(0xff2a2a, { emissive: 0xff2a2a, emissiveIntensity: 0.8 }))
      tail.rotation.x = Math.PI / 2
      tail.position.set(x + dx, 0.42, -2.42)
      g.add(tail)
    }
  }
  // A low nose intake, the oil cooler duct under it, and the pipes swept out of the flanks.
  g.add(box(0.7, 0.08, 0.06, 0, 0.2, 2.3, dark))
  g.add(box(0.44, 0.05, 0.05, 0, 0.12, 2.24, dark))
  for (const x of [-0.3, 0.3]) g.add(cyl(0.06, 0.5, x, 0.26, -2.4, dark, true))
  // Wheels: fat, and standing out under the crowns rather than swallowed by them. The rears are
  // wider and taller, which is most of why one of these cars looks planted from behind.
  for (const [x, z, r, w] of [
    [-1.02, 1.34, 0.33, 0.3],
    [1.02, 1.34, 0.33, 0.3],
    [-0.95, -1.3, 0.35, 0.36],
    [0.95, -1.3, 0.35, 0.36],
  ]) {
    const tyre = new Mesh(new CylinderGeometry(r, r, w, 14), dark)
    tyre.rotation.z = Math.PI / 2
    tyre.position.set(x, r, z)
    g.add(tyre)
    const rim = new Mesh(new CylinderGeometry(r * 0.58, r * 0.58, w + 0.02, 8), flat(0xbfc6d0, { metalness: 0.8, roughness: 0.3 }))
    rim.rotation.z = Math.PI / 2
    rim.position.set(x, r, z)
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

/**
 * A street facade: the building front you drive past — a ground-floor shopfront with an
 * awning, floors of windows above, a parapet. Narrow enough to sit right at the kerb,
 * shallow because only the face matters. `lit` glows for the night city.
 */
export function buildFacade(w: number, floors: number, tint: number, awning: number, lit: boolean): Object3D {
  const g = new Group()
  const fh = 3.4
  const h = 4.2 + floors * fh
  g.add(box(w, h, 5, 0, h / 2, 0, flat(tint)))
  // Shopfront: big glass, a dark door, an awning.
  const glass = flat(lit ? 0xfff0b0 : 0x3a5068, lit ? { emissive: 0xffd080, emissiveIntensity: 1.1 } : { metalness: 0.3 })
  // The atlas camera looks at the -z face, so everything worth seeing goes on that side.
  g.add(box(w * 0.7, 2.4, 0.1, -w * 0.1, 1.6, -2.55, glass))
  g.add(box(1.2, 2.8, 0.1, w * 0.35, 1.4, -2.55, flat(0x30282a)))
  g.add(box(w * 0.92, 0.25, 1.6, 0, 3.4, -3.2, flat(awning)))
  // Floors of windows.
  const win = flat(lit ? 0xffe6a0 : 0x2a3a52, lit ? { emissive: 0xffd080, emissiveIntensity: 1.0 } : {})
  const dark = flat(0x1a2030)
  for (let f = 0; f < floors; f++) {
    const y = 4.2 + f * fh + fh / 2
    for (let x = -w / 2 + 1.1; x < w / 2 - 0.6; x += 1.9) {
      const on = !lit || ((x * 7 + f * 13) | 0) % 4 !== 0
      g.add(box(1.2, 1.6, 0.1, x, y, -2.55, on ? win : dark))
    }
    g.add(box(w + 0.1, 0.18, 0.2, 0, 4.2 + f * fh, -2.55, flat(0x8a8a90)))
  }
  g.add(box(w + 0.4, 0.5, 5.4, 0, h + 0.25, 0, flat(0x5a5e6a)))
  return g
}

/** A downtown mid-rise: a slab with a grid of daytime (unlit) windows and a parapet. */
export function buildBlock(h: number, w: number, tint: number): Object3D {
  const g = new Group()
  g.add(box(w, h, w * 0.8, 0, h / 2, 0, flat(tint)))
  const glass = flat(0x2a3a52, { metalness: 0.2 })
  for (let y = 1.6; y < h - 1.2; y += 2.6)
    for (let x = -w / 2 + 1.2; x < w / 2 - 0.6; x += 2.0) g.add(box(1.2, 1.4, 0.1, x, y, -(w * 0.8) / 2 - 0.05, glass))
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
