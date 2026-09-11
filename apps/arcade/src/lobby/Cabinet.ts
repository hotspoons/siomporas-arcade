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
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector3,
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
  /** The wheel on the control deck, which is geometry rather than a hole in the artwork. */
  wheelRadius: 0.105,
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

/**
 * Where a face sits in the world: the middle of it, the outward normal, and the rotation about X
 * that stands something up along that normal. `facePlane` works this out for its own corners; this
 * hands the same numbers to whatever has to sit *on* the face.
 */
function faceFrame(a: Pt, b: Pt): { y: number; z: number; ny: number; nz: number; uy: number; uz: number; tilt: number } {
  const [ay, az] = zy(a)
  const [by, bz] = zy(b)
  const len = Math.hypot(by - ay, bz - az)
  const uy = (by - ay) / len
  const uz = (bz - az) / len
  const ny = -uz
  const nz = uy
  // Rx(t) takes +z to (0, -sin t, cos t), so this is the turn that lays a disc flat on the face.
  return { y: (ay + by) / 2, z: (az + bz) / 2, ny, nz, uy, uz, tilt: Math.atan2(-ny, nz) }
}

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
  /** The pane the game plays on — what a pointer has to hit to zoom in on it. */
  readonly screen: Mesh
  /**
   * Where that pane is and which way it faces, in the cabinet's own space. `facePlane` keeps a
   * face's offset in its geometry rather than in the mesh's transform, so a mesh's position is the
   * cabinet's base and asking the screen where it is gets you the floor.
   */
  readonly screenCentre: Vector3
  readonly screenNormal: Vector3
  private readonly art: CabinetArt
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
    this.art = art
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
    // A cabinet has two flanks and they are different pictures. One on its own is mirrored onto both
    // rather than leaving a bare side, which is what happens while only half the art exists.
    // Mapped to the silhouette's bounding box, which is what ART.md tells the generator to draw to.
    for (const sign of [1, -1]) {
      const tex = art.texture(sign > 0 ? 'side-right' : 'side-left') ?? art.texture(sign > 0 ? 'side-left' : 'side-right')
      if (!tex) continue
      const mat = new MeshStandardMaterial({ map: tex, roughness: 0.55 })
      const geo = new PlaneGeometry(CAB.depth, totalH)
      // A plane faces +z and a quarter turn each way puts one on each flank facing outward — but the
      // two then disagree about which way is left, so one of them shows its artwork mirrored. Flip
      // the far side's u instead of its geometry.
      if (sign < 0) {
        const uv = geo.getAttribute('uv')
        for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i))
        uv.needsUpdate = true
      }
      const m = new Mesh(geo, mat)
      m.position.set(sign * (CAB.width / 2 + 0.002), totalH / 2, -CAB.depth / 2)
      m.rotation.y = sign * (Math.PI / 2)
      this.group.add(m)
      this.owned.push(geo, mat)
    }

    // --- control deck and bezel -------------------------------------------
    const deckTex = art.texture('panel')
    if (deckTex) {
      const g = facePlane({ z: 0, y: CAB.kickTop }, deckTop, CAB.width, 0.003)
      const m = new MeshStandardMaterial({ map: deckTex, roughness: 0.5 })
      this.group.add(new Mesh(g, m))
      this.owned.push(g, m)
    }

    // The controls themselves, in geometry rather than painted on. Artwork that has to leave holes
    // for a wheel and three buttons is artwork with holes in it, which is a hard thing to ask a
    // generator for and a worse thing to get slightly wrong. Real controls standing proud of the
    // deck also read as a cabinet from across the room, which a dark circle does not.
    const deck = faceFrame({ z: 0, y: CAB.kickTop }, deckTop)
    const stand = (lift: number, x: number, along = 0): [number, number, number] => [
      x,
      deck.y + deck.ny * lift + deck.uy * along,
      deck.z + deck.nz * lift + deck.uz * along,
    ]
    const dark = new MeshStandardMaterial({ color: 0x15171c, roughness: 0.45, metalness: 0.25 })
    const lit = new MeshStandardMaterial({ color: this.glow, roughness: 0.35, emissive: this.glow, emissiveIntensity: 0.25 })
    this.owned.push(dark, lit)

    if (game.controls === 'yoke') {
      // S.T.U.N. Runner's yoke: a bar across the deck on a stem, with a grip at each end. Not a
      // wheel, which is the thing everyone gets wrong about that machine.
      const stemGeo = new CylinderGeometry(0.028, 0.034, 0.1, 10)
      const stem = new Mesh(stemGeo, dark)
      stem.position.set(...stand(0.05, 0, -0.01))
      stem.rotation.x = deck.tilt + Math.PI / 2
      this.group.add(stem)
      const barGeo = new CylinderGeometry(0.017, 0.017, 0.3, 10)
      const bar = new Mesh(barGeo, dark)
      bar.position.set(...stand(0.1, 0, -0.01))
      bar.rotation.z = Math.PI / 2
      this.group.add(bar)
      const gripGeo = new CylinderGeometry(0.026, 0.026, 0.075, 10)
      for (const sx of [-1, 1]) {
        const grip = new Mesh(gripGeo, dark)
        grip.position.set(...stand(0.1, sx * 0.15, -0.01))
        grip.rotation.x = deck.tilt + Math.PI / 2
        this.group.add(grip)
        const fire = new Mesh(new CylinderGeometry(0.013, 0.013, 0.012, 10), lit)
        fire.position.set(...stand(0.14, sx * 0.15, -0.01))
        fire.rotation.x = deck.tilt + Math.PI / 2
        this.group.add(fire)
        this.owned.push(fire.geometry)
      }
      this.owned.push(stemGeo, barGeo, gripGeo)
    } else {
      const rim = new TorusGeometry(CAB.wheelRadius, CAB.wheelRadius * 0.16, 8, 28)
      const wheel = new Mesh(rim, dark)
      wheel.position.set(...stand(0.02, -0.04))
      wheel.rotation.x = deck.tilt
      this.group.add(wheel)
      const hubGeo = new CylinderGeometry(CAB.wheelRadius * 0.3, CAB.wheelRadius * 0.3, 0.012, 12)
      const hub = new Mesh(hubGeo, dark)
      hub.position.set(...stand(0.016, -0.04))
      // A cylinder stands along +y; the quarter turn puts its axis along the face's normal instead.
      hub.rotation.x = deck.tilt + Math.PI / 2
      this.group.add(hub)

      // The shifter, to the right of the wheel where it belongs, leaning back out of the deck.
      const gateGeo = new BoxGeometry(0.07, 0.012, 0.1)
      const gate = new Mesh(gateGeo, dark)
      gate.position.set(...stand(0.012, 0.235))
      gate.rotation.x = deck.tilt
      this.group.add(gate)
      const stickGeo = new CylinderGeometry(0.009, 0.011, 0.11, 8)
      const stick = new Mesh(stickGeo, dark)
      stick.position.set(...stand(0.06, 0.235, 0.01))
      stick.rotation.set(deck.tilt + Math.PI / 2 - 0.35, 0, 0)
      this.group.add(stick)
      const knobGeo = new SphereGeometry(0.021, 12, 8)
      const knob = new Mesh(knobGeo, lit)
      knob.position.set(...stand(0.115, 0.235, 0.03))
      this.group.add(knob)
      this.owned.push(rim, hubGeo, gateGeo, stickGeo, knobGeo)

      const buttonGeo = new CylinderGeometry(0.019, 0.019, 0.014, 12)
      for (const x of [0.115, 0.17]) {
        const b = new Mesh(buttonGeo, lit)
        b.position.set(...stand(0.018, x, -0.06))
        b.rotation.x = deck.tilt + Math.PI / 2
        this.group.add(b)
      }
      this.owned.push(buttonGeo)

      // Pedals. A stand-up driving cabinet still has them, on a plate at the foot of the kick panel.
      const plateGeo = new BoxGeometry(0.34, 0.02, 0.22)
      const plate = new Mesh(plateGeo, dark)
      plate.position.set(0, 0.012, CAB.depth * 0.06)
      this.group.add(plate)
      const pedalGeo = new BoxGeometry(0.075, 0.016, 0.13)
      for (const [px, tilt] of [
        [-0.075, -0.32],
        [0.075, -0.26],
      ]) {
        const pedal = new Mesh(pedalGeo, px < 0 ? dark : lit)
        pedal.position.set(px, 0.045, CAB.depth * 0.06)
        pedal.rotation.x = tilt
        this.group.add(pedal)
      }
      this.owned.push(plateGeo, pedalGeo)
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
    const attract = art.attract()
    // With no attract art the screen is a dark pane rather than a hole: a touch of the game's own
    // colour, so an unfinished cabinet still looks switched on.
    this.screenMat = new MeshBasicMaterial({ map: attract, color: attract ? 0xffffff : new Color(game.body).multiplyScalar(0.5), toneMapped: false })
    const screenFace = faceFrame({ z: bezelBottom.z + inset * 0.3, y: bezelBottom.y + inset }, { z: bezelTop.z - inset * 0.3, y: bezelTop.y - inset })
    this.screenCentre = new Vector3(0, screenFace.y + screenFace.ny * 0.006, screenFace.z + screenFace.nz * 0.006)
    this.screenNormal = new Vector3(0, screenFace.ny, screenFace.nz)
    this.screen = new Mesh(screenGeo, this.screenMat)
    this.group.add(this.screen)
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
    // The loop runs on the cabinet being looked at and nowhere else.
    this.art.setAttractPlaying(t > 0.35)
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
