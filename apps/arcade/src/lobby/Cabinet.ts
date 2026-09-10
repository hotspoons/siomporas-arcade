// One arcade cabinet: an extruded body in the game's colour, with flat artwork panels laid just
// proud of the faces that carry art.
//
// The body is one extruded silhouette rather than a box, because the silhouette *is* the thing you
// recognise across a dark room — the kicked-back screen, the shelf of the control deck, the sign
// on top. Art is not textured onto that geometry; it is separate quads floating a couple of
// millimetres off it. That way a panel's aspect ratio is free to be whatever the image generator
// produced (see ART.md) without stretching, a missing panel simply leaves painted body showing
// through, and re-cutting one texture never means touching geometry.
//
// Two spaces are in play and mixing them up is the easy mistake here:
//
//   silhouette space   (z, y) — z is depth measured BACKWARD from the front of the cabinet, y is
//                      height off the floor. Every constant below is in this space.
//   world space        x across the cabinet, y up, z toward the aisle. The front face is at z = 0
//                      and the back at z = -CAB.depth, so the cabinet faces +z and the camera
//                      stands out at +z looking back at it.
//
// `zy()` is the only place the two meet.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Shape,
} from 'three'
import type { ArcadeGame } from '../catalog'
import type { CabinetArt } from './CabinetArt'

/** Metres. Modelled life size, so the room and the camera can be too. */
export const CAB = {
  width: 0.72,
  depth: 0.86,
  /** Top of the kick panel, where the control deck starts. */
  kickTop: 0.9,
  /** How far the control deck reaches back, and how far it climbs over that run. */
  deckRun: 0.24,
  deckRise: 0.12,
  /** The screen plane, from the back of the deck up to the shelf under the marquee. */
  bezelTop: 1.5,
  bezelLean: 0.13,
  /** The marquee sits above the bezel, set back, and is as tall as its artwork demands. */
  marqueeGap: 0.05,
  marqueeInset: 0.04,
  /** Height of the sign for a game whose marquee art has not landed yet. */
  marqueeFallbackH: 0.4,
} as const

interface Pt {
  z: number
  y: number
}

const deckTop: Pt = { z: CAB.deckRun, y: CAB.kickTop + CAB.deckRise }
const bezelBottom: Pt = { z: deckTop.z, y: deckTop.y + 0.04 }
const bezelTop: Pt = { z: deckTop.z + CAB.bezelLean, y: CAB.bezelTop }
const marqueeZ = bezelTop.z + CAB.marqueeInset

/** Silhouette space to world space. */
const zy = (p: Pt): [number, number] => [p.y, -p.z]

/** The side silhouette, in silhouette space, with the front at z = 0. */
function silhouette(marqueeH: number): Shape {
  const s = new Shape()
  const mBottom = CAB.bezelTop + CAB.marqueeGap
  const mTop = mBottom + marqueeH
  s.moveTo(0, 0)
  s.lineTo(0, CAB.kickTop) // front face, floor to deck
  s.lineTo(deckTop.z, deckTop.y) // the control deck, climbing back
  s.lineTo(bezelBottom.z, bezelBottom.y)
  s.lineTo(bezelTop.z, bezelTop.y) // the screen, leaning back
  s.lineTo(marqueeZ, bezelTop.y) // the shelf under the sign
  s.lineTo(marqueeZ, mTop) // the sign
  s.lineTo(CAB.depth, mTop) // over the top
  s.lineTo(CAB.depth, 0) // down the back
  s.closePath()
  return s
}

/**
 * A textured quad spanning silhouette-space points `a` (bottom) to `b` (top), `width` across X and
 * pushed `lift` along its own outward normal so it never fights the body for the same depth.
 *
 * Corners are placed by hand rather than by rotating a PlaneGeometry: the winding and the UVs both
 * have to come out right for a face that can be vertical, tilted back or nearly horizontal, and
 * three rotations composed in the wrong order is how you get artwork upside down on one panel only.
 */
function facePlane(a: Pt, b: Pt, width: number, lift: number): BufferGeometry {
  const [ay, az] = zy(a)
  const [by, bz] = zy(b)
  const dy = by - ay
  const dz = bz - az
  const len = Math.hypot(dy, dz)
  // Up-the-face unit vector, and the outward normal a quarter turn from it toward the aisle.
  const uy = dy / len
  const uz = dz / len
  const ny = -uz
  const nz = uy
  const cy = (ay + by) / 2 + ny * lift
  const cz = (az + bz) / 2 + nz * lift
  const hw = width / 2
  const hl = len / 2

  const corner = (sx: number, sl: number): [number, number, number] => [sx * hw, cy + uy * hl * sl, cz + uz * hl * sl]
  const bl = corner(-1, -1)
  const br = corner(1, -1)
  const tr = corner(1, 1)
  const tl = corner(-1, 1)

  const g = new BufferGeometry()
  // Counter-clockwise seen from the aisle, so the front face is the one that faces the player.
  g.setAttribute('position', new Float32BufferAttribute([...bl, ...br, ...tr, ...bl, ...tr, ...tl], 3))
  g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2))
  g.computeVertexNormals()
  return g
}

export class Cabinet {
  readonly group = new Group()
  readonly marqueeLight: PointLight
  /** How tall the sign turned out, once its artwork was measured. */
  readonly marqueeHeight: number

  private readonly owned: Array<{ dispose(): void }> = []
  private readonly marqueeMat: MeshBasicMaterial
  private readonly screenMat: MeshBasicMaterial
  private readonly glow: Color
  private lit = 0

  readonly game: ArcadeGame

  constructor(game: ArcadeGame, art: CabinetArt) {
    this.game = game
    this.glow = new Color(game.glow)
    const marqueeAspect = art.aspect('marquee')
    this.marqueeHeight = marqueeAspect ? CAB.width / marqueeAspect : CAB.marqueeFallbackH
    const totalH = this.height

    // --- body -------------------------------------------------------------
    const body = new ExtrudeGeometry(silhouette(this.marqueeHeight), { depth: CAB.width, bevelEnabled: false })
    // Extruded along its own +Z: stand it up so the silhouette lands in the world zy-plane and the
    // extrusion runs across X, then centre it on the cabinet's middle.
    body.rotateY(Math.PI / 2)
    body.translate(-CAB.width / 2, 0, 0)
    // DoubleSide because whether the extrusion's caps end up front- or back-facing depends on the
    // winding of a Shape that is easier to read in the order written above than in the right one.
    const bodyMat = new MeshStandardMaterial({ color: game.body, roughness: 0.62, metalness: 0.05, side: DoubleSide })
    this.group.add(new Mesh(body, bodyMat))
    this.owned.push(body, bodyMat)

    // --- marquee ----------------------------------------------------------
    // Basic and untone-mapped, not standard: a marquee is a lightbox. It is a source, not a
    // surface, so it must not go dark when the room does — its brightness is dialled in setSelected.
    const mBottom = CAB.bezelTop + CAB.marqueeGap
    const hasMarquee = art.has('marquee')
    this.marqueeMat = new MeshBasicMaterial({ map: art.texture('marquee'), toneMapped: false })
    const marqueeGeo = facePlane({ z: marqueeZ, y: mBottom }, { z: marqueeZ, y: mBottom + this.marqueeHeight }, CAB.width, 0.003)
    this.group.add(new Mesh(marqueeGeo, this.marqueeMat))
    this.owned.push(marqueeGeo, this.marqueeMat)

    // The sign is what lights the aisle — and its own cabinet. It has to sit well out in front of
    // the glass: level with it, every face below it is lit at grazing incidence and the whole lower
    // half of the cabinet renders black.
    this.marqueeLight = new PointLight(this.glow, 0, 6, 2)
    this.marqueeLight.position.set(0, mBottom + this.marqueeHeight / 2 - 0.15, 0.55)
    this.group.add(this.marqueeLight)

    // --- side art ---------------------------------------------------------
    // Mapped to the silhouette's bounding box, which is what ART.md tells the generator to draw to.
    const sideTex = art.texture('side')
    if (sideTex) {
      const sideMat = new MeshStandardMaterial({ map: sideTex, roughness: 0.55 })
      const sideGeo = new PlaneGeometry(CAB.depth, totalH)
      this.owned.push(sideGeo, sideMat)
      for (const sign of [1, -1]) {
        const m = new Mesh(sideGeo, sideMat)
        m.position.set(sign * (CAB.width / 2 + 0.002), totalH / 2, -CAB.depth / 2)
        // A plane faces +z; a quarter turn each way puts one on each flank, both facing outward.
        m.rotation.y = sign * (Math.PI / 2)
        this.group.add(m)
      }
    }

    // --- control deck and bezel -------------------------------------------
    const deckTex = art.texture('panel')
    if (deckTex) {
      const g = facePlane({ z: 0, y: CAB.kickTop }, deckTop, CAB.width, 0.003)
      const m = new MeshStandardMaterial({ map: deckTex, roughness: 0.5 })
      this.group.add(new Mesh(g, m))
      this.owned.push(g, m)
    }

    const bezelTex = art.texture('bezel')
    if (bezelTex) {
      const g = facePlane(bezelBottom, bezelTop, CAB.width, 0.003)
      const m = new MeshStandardMaterial({ map: bezelTex, roughness: 0.4 })
      this.group.add(new Mesh(g, m))
      this.owned.push(g, m)
    }

    // --- screen -----------------------------------------------------------
    // Inside the bezel's opening: inset all round, and a touch further proud so it reads as glass
    // sitting in a frame rather than as another decal.
    const inset = 0.1
    const screenGeo = facePlane(
      { z: bezelBottom.z + inset * 0.3, y: bezelBottom.y + inset },
      { z: bezelTop.z - inset * 0.3, y: bezelTop.y - inset },
      CAB.width - inset * 2,
      bezelTex ? 0.005 : 0.004,
    )
    const attract = art.texture('attract')
    // With no attract art the screen is a dark pane rather than a hole: a touch of the game's own
    // colour, so an unfinished cabinet still looks switched on.
    this.screenMat = new MeshBasicMaterial({ map: attract, color: attract ? 0xffffff : new Color(game.body).multiplyScalar(0.5), toneMapped: false })
    this.group.add(new Mesh(screenGeo, this.screenMat))
    this.owned.push(screenGeo, this.screenMat)

    if (!hasMarquee) this.marqueeMat.color.copy(this.glow)
    this.setSelected(0)
  }

  /** The whole cabinet's height, sign included — what the camera's framing needs to know. */
  get height(): number {
    return CAB.bezelTop + CAB.marqueeGap + this.marqueeHeight
  }

  /**
   * How lit this cabinet is: 0 is a dark shape down the aisle, 1 is the one you are standing at.
   * Everything about being selected hangs off this single dial so the row can be driven by an eased
   * value and be halfway between two cabinets without anything popping.
   */
  setSelected(t: number): void {
    this.lit = t
    const dim = 0.36 + 0.64 * t
    if (this.marqueeMat.map) this.marqueeMat.color.setScalar(dim)
    else this.marqueeMat.color.copy(this.glow).multiplyScalar(dim)
    // Physical units with quadratic falloff: intensity is candela, so lighting a cabinet two
    // metres away wants tens, not units. Getting this wrong is why the room was black.
    this.marqueeLight.intensity = 3.5 + 24 * t
    if (this.screenMat.map) this.screenMat.color.setScalar(0.25 + 0.75 * t)
  }

  get selected(): number {
    return this.lit
  }

  dispose(): void {
    for (const o of this.owned) o.dispose()
    this.owned.length = 0
    this.group.clear()
  }
}
