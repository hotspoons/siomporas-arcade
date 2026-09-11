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
  PointLight,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import type { ArcadeGame } from '../catalog'
import type { CabinetArt } from './CabinetArt'

/**
 * The control deck sits a hand's width under the sign, which is a real light: at a white albedo it
 * is lit at dozens of times the exposure the rest of the room is, clips, and comes out as a flat
 * orange slab. Printed vinyl is not a white card, and this is where that gets said.
 *
 * The bezel has the same problem and cannot be solved the same way, because it is the one panel you
 * put your nose against — so it is unlit instead, like the marquee and the screen either side of
 * it, and its brightness is dialled by selection rather than by where a lamp happens to be. That
 * keeps the artwork the colour it was drawn, which at 30 cm is the whole point of it.
 */
const DECK_ALBEDO = 0.34
const BEZEL_DIM = { off: 0.34, on: 0.88 }

/**
 * Metres, traced off a scan of a real Ikari Warriors upright — 1829 tall, 840 deep, 641 wide — with
 * the silhouette projected along its width and measured at every height. Worth doing properly,
 * because the side of an upright is a shape people know by heart whether or not they have ever
 * thought about it, and it is not a shape anybody guesses right.
 *
 * Bottom to top, the front of the machine is: a base standing back; a control panel swelling out
 * from under it to the lip, which is the furthest-forward part of the whole cabinet; the deck
 * running back and up; then the monitor, leaning back **19 degrees** — that tilt is the single thing
 * that reads as "arcade" and the thing every reconstruction gets wrong; then a panel raked sharply
 * forward over the top of it, which is where the speakers live; then the sign, vertical, tucked
 * right back over the lip; and a top that slopes down towards the back.
 *
 * Everything below the sign is the scan's own measurements. The sign itself is as tall as its
 * artwork needs, which makes ours a taller-headed machine than the one scanned: a marquee here is
 * the menu, so it is legible first and period-correct second.
 */
export const CAB = {
  width: 0.72,
  depth: 0.81,
  /** Thickness of a side board, and how far behind their front edges the machine itself sits. */
  side: 0.028,
  recess: 0.012,
  /** The base, standing back under the control panel. */
  baseZ: 0.125,
  baseTop: 0.76,
  /** The control panel's lip: nothing on the machine stands further forward than this. */
  lipY: 0.9,
  /**
   * The deck, running back and up from that lip at the scan's own rake. Two centimetres deeper than
   * the scan, which is a joystick cabinet: a 21 cm wheel lying in the panel needs 21 cm of it, and
   * the panel it came off has 18 cm total. Everything above rides on this number —
   * the deck's back edge is the monitor's foot — so it is kept as close to the scan as a wheel allows.
   */
  deckRun: 0.2,
  deckRise: 0.118,
  /** The wheel itself, which is geometry rather than a hole in the artwork. */
  wheelRadius: 0.105,
  /** The monitor: how far it climbs, and how far back it leans doing it. 19.1 degrees, measured. */
  bezelRise: 0.42,
  bezelLean: 0.145,
  /** The glass: a 20-inch tube, which is what the bezel was measured around. */
  screen: { w: 0.4, h: 0.3 },
  /** The speakers, in the panel raked over the monitor. */
  speakerRadius: 0.052,
  speakerX: 0.155,
  /** The sign: how far back its face sits, and how high its foot is. */
  marqueeZ: 0.095,
  marqueeBottom: 1.63,
  /** Height of the sign for a game whose marquee art has not landed yet. */
  marqueeFallbackH: 0.34,
  /** The top: a lip above the sign, then flat, then sloping away to the back. */
  topRise: 0.015,
  topChamfer: 0.012,
  topFlat: 0.274,
  backDrop: 0.226,
} as const

/** The width of everything between the two boards: the body, and every face that carries art. */
const INNER = CAB.width - 2 * CAB.side

interface Pt {
  z: number
  y: number
}

const lip: Pt = { z: 0, y: CAB.lipY }
const deckBack: Pt = { z: CAB.deckRun, y: CAB.lipY + CAB.deckRise }
/** The monitor runs from the back of the deck up and back. */
const bezelBottom: Pt = deckBack
const bezelTop: Pt = { z: deckBack.z + CAB.bezelLean, y: deckBack.y + CAB.bezelRise }
/** The sign's foot, which is also the top of the panel the speakers are in. */
const marqueeFoot: Pt = { z: CAB.marqueeZ, y: CAB.marqueeBottom }

/** Everything that carries art stands `recess` behind the boards, between them. */
const recessed = (p: Pt): Pt => ({ z: p.z + CAB.recess, y: p.y })

/** The glass, centred on the bezel face rather than inset from its edges — a tube is a fixed size. */
const bezelLen = Math.hypot(bezelTop.z - bezelBottom.z, bezelTop.y - bezelBottom.y)
const alongBezel = (t: number): Pt => ({
  z: bezelBottom.z + (bezelTop.z - bezelBottom.z) * t,
  y: bezelBottom.y + (bezelTop.y - bezelBottom.y) * t,
})
const screenBottom: Pt = recessed(alongBezel((1 - CAB.screen.h / bezelLen) / 2))
const screenTop: Pt = recessed(alongBezel((1 + CAB.screen.h / bezelLen) / 2))

/** The deck's face: from the control panel's lip back to the foot of the monitor. */
const deckLen = Math.hypot(deckBack.z - lip.z, deckBack.y - lip.y)
/**
 * The sign is as tall as its own artwork, so the shape of that artwork decides how tall the machine
 * is. Sixteen by nine is the shape the templates ask for, and asking for one shape is what keeps a
 * row of cabinets the same height as each other.
 */
const MARQUEE_ASPECT = 16 / 9

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

/**
 * The side of the machine, front at z = 0, floor at y = 0 — the board's outline and, stepped back by
 * `recess`, the body's too. One shape: the side board is not a different silhouette from the cabinet
 * it is bolted to, it is the same silhouette standing a centimetre proud of it, and the screen, the
 * speakers, the deck and the sign all sit in the channel that leaves between the two boards.
 *
 * The deep notch between the control panel and the sign is the whole shape. Filling it in — which is
 * what a rectangle, or a convex hull, or any amount of good intentions will do — gets you a wardrobe.
 */
function profilePoints(marqueeH: number): Pt[] {
  const signTop = CAB.marqueeBottom + marqueeH
  const top = signTop + CAB.topRise
  return [
    { z: CAB.baseZ, y: 0 },
    { z: CAB.baseZ, y: CAB.baseTop }, // the base, standing back
    { z: 0.084, y: 0.8 }, // the control panel swelling out from under it
    { z: 0.03, y: 0.86 },
    lip, // the lip: the front of the machine
    deckBack, // the deck, running back and up
    bezelTop, // the monitor, leaning back 19 degrees
    marqueeFoot, // the speaker panel, raked forward over it
    { z: CAB.marqueeZ, y: signTop }, // the sign, vertical
    { z: CAB.marqueeZ + CAB.topChamfer, y: top }, // a lip above it
    { z: CAB.topFlat, y: top }, // flat over the top
    { z: CAB.depth, y: top - CAB.backDrop }, // sloping away to the back
    { z: CAB.depth, y: 0 }, // down the back
  ]
}

/** The same outline, stepped back: the machine between the boards. */
function bodyPoints(marqueeH: number): Pt[] {
  return profilePoints(marqueeH).map((p) => (p.z >= CAB.depth - 1e-6 ? p : recessed(p)))
}

function shapeOf(pts: Pt[]): Shape {
  const s = new Shape()
  s.moveTo(pts[0].z, pts[0].y)
  for (const p of pts.slice(1)) s.lineTo(p.z, p.y)
  s.closePath()
  return s
}

/**
 * Everything artwork has to fit, in one place: the shape of each face of the machine, and where the
 * things that stand on top of a face are.
 *
 * This is the contract between the cabinet and the four scripts that prepare artwork for it —
 * `scripts/lib/fit.mjs` is the same numbers again, because those scripts run over images at install
 * time and never ship, so they cannot import any of this. apps/arcade/test/cabinet-art.test.ts fails
 * if the two ever drift apart, which is the only thing keeping the templates honest.
 *
 * Fractions throughout, y running down the way an image does. The flank is measured with a nominal
 * 16:9 sign, because a template cannot know how tall a sign a game has not drawn yet will be.
 */
export const ART_FIT = ((): {
  marquee: number
  deck: number
  screen: number
  bezel: { aspect: number; hole: { x0: number; y0: number; x1: number; y1: number } }
  flank: { aspect: number; outline: Array<[number, number]> }
} => {
  const marqueeH = INNER / MARQUEE_ASPECT
  const height = CAB.marqueeBottom + marqueeH + CAB.topRise
  const x = (1 - CAB.screen.w / INNER) / 2
  const y = (1 - CAB.screen.h / bezelLen) / 2
  return {
    marquee: MARQUEE_ASPECT,
    deck: INNER / deckLen,
    screen: CAB.screen.w / CAB.screen.h,
    bezel: { aspect: INNER / bezelLen, hole: { x0: x, y0: y, x1: 1 - x, y1: 1 - y } },
    flank: {
      aspect: CAB.depth / height,
      outline: profilePoints(marqueeH).map((p) => [p.z / CAB.depth, 1 - p.y / height] as [number, number]),
    },
  }
})()

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

/**
 * A flank: the side board's outline, not a rectangle.
 *
 * Side art is a decal stuck on the side of a machine, so it stops where the board does. A rectangle
 * the size of the bounding box hangs off the back of it and over the top, which reads as a poster
 * standing behind the cabinet rather than as artwork on it. So the board's own outline is
 * triangulated flat and hung a couple of millimetres off it.
 *
 * The artwork is drawn to that bounding box (ART.md says so), and is fitted to it *covering* rather
 * than stretched: a panel that came back the wrong shape loses a little off one pair of edges
 * instead of making the whole machine look squashed.
 *
 * Two things about the mapping, both easy to get backwards:
 *
 *   u   runs toward the back of the cabinet on the right flank and toward the front on the left.
 *       Those are the same direction — screen-right — because you look at the two from opposite
 *       sides. Making both run the same way in world space is what puts one logo on mirrored.
 *   winding   the triangles come out facing +x, which is the right way for the right flank only, so
 *       the left one's are turned round rather than being made double-sided.
 */
function flankGeometry(marqueeH: number, height: number, sign: number, artAspect: number | null): BufferGeometry {
  const g = new ShapeGeometry(shapeOf(profilePoints(marqueeH)))
  const pos = g.getAttribute('position')
  const uv = new Float32Array(pos.count * 2)
  const box = CAB.depth / height
  const a = artAspect ?? box
  const uk = a > box ? box / a : 1
  const vk = a > box ? 1 : a / box
  for (let i = 0; i < pos.count; i++) {
    // Shape space is the silhouette's: x is depth measured back from the front, y is height.
    const sz = pos.getX(i)
    const sy = pos.getY(i)
    const u = sign > 0 ? sz / CAB.depth : 1 - sz / CAB.depth
    uv[i * 2] = 0.5 + (u - 0.5) * uk
    uv[i * 2 + 1] = 0.5 + (sy / height - 0.5) * vk
    pos.setXYZ(i, sign * (CAB.width / 2 + 0.002), sy, -sz)
  }
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  const index = g.getIndex()
  if (sign < 0 && index) {
    const tri = index.array
    for (let i = 0; i < tri.length; i += 3) {
      const swap = tri[i + 1]
      tri[i + 1] = tri[i + 2]
      tri[i + 2] = swap
    }
    index.needsUpdate = true
  }
  pos.needsUpdate = true
  g.computeVertexNormals()
  return g
}

/**
 * The largest piece of a face that artwork of a given shape fits inside, centred on it.
 *
 * A control panel drawn as a 6:1 strip does not become a 3:1 panel by being stretched onto one. It
 * becomes a band of artwork across the middle of a painted deck — which is what a real control panel
 * is anyway, and is the only outcome here that neither distorts the artwork nor throws any of it
 * away. `null` for artwork whose shape is unknown, which then simply fills the face.
 */
function fitFace(a: Pt, b: Pt, width: number, artAspect: number | null): { a: Pt; b: Pt; width: number } {
  if (!artAspect) return { a, b, width }
  const len = Math.hypot(b.z - a.z, b.y - a.y)
  if (artAspect < width / len) return { a, b, width: len * artAspect }
  const keep = width / artAspect / len
  const at = (t: number): Pt => ({ z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t })
  return { a: at((1 - keep) / 2), b: at((1 + keep) / 2), width }
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
  private readonly bezelMat: MeshBasicMaterial | null
  private readonly screenMat: MeshBasicMaterial
  private readonly glow: Color
  private lit = 0

  readonly game: ArcadeGame

  constructor(game: ArcadeGame, art: CabinetArt) {
    this.game = game
    this.art = art
    this.glow = new Color(game.glow)
    const marqueeAspect = art.aspect('marquee')
    this.marqueeHeight = marqueeAspect ? INNER / marqueeAspect : INNER / MARQUEE_ASPECT
    const totalH = this.height

    // --- body and boards ---------------------------------------------------
    // DoubleSide because whether an extrusion's caps end up front- or back-facing depends on the
    // winding of a Shape that is easier to read in the order written above than in the right one.
    const bodyMat = new MeshStandardMaterial({ color: game.body, roughness: 0.62, metalness: 0.05, side: DoubleSide })
    this.owned.push(bodyMat)
    // Extruded along its own +Z: stood up so the profile lands in the world zy-plane and the
    // extrusion runs across X. The body is the width between the boards, not the width of the
    // machine, so the screen and the sign sit in a recess with a board either side of them.
    const body = new ExtrudeGeometry(shapeOf(bodyPoints(this.marqueeHeight)), { depth: INNER, bevelEnabled: false })
    body.rotateY(Math.PI / 2)
    body.translate(-INNER / 2, 0, 0)
    this.group.add(new Mesh(body, bodyMat))
    this.owned.push(body)

    const boardShape = shapeOf(profilePoints(this.marqueeHeight))
    for (const sign of [1, -1]) {
      const board = new ExtrudeGeometry(boardShape, { depth: CAB.side, bevelEnabled: false })
      board.rotateY(Math.PI / 2)
      board.translate(sign > 0 ? INNER / 2 : -CAB.width / 2, 0, 0)
      this.group.add(new Mesh(board, bodyMat))
      this.owned.push(board)
    }

    // --- marquee ----------------------------------------------------------
    // Basic and untone-mapped, not standard: a marquee is a lightbox. It is a source, not a
    // surface, so it must not go dark when the room does — its brightness is dialled in setSelected.
    const mBottom = CAB.marqueeBottom
    const hasMarquee = art.has('marquee')
    this.marqueeMat = new MeshBasicMaterial({ map: art.texture('marquee'), toneMapped: false })
    const marqueeGeo = facePlane(recessed(marqueeFoot), recessed({ z: CAB.marqueeZ, y: mBottom + this.marqueeHeight }), INNER, 0.003)
    this.group.add(new Mesh(marqueeGeo, this.marqueeMat))
    this.owned.push(marqueeGeo, this.marqueeMat)

    // The sign is what lights the aisle — and its own cabinet. It has to sit well out in front of
    // the glass: level with it, every face below it is lit at grazing incidence and the whole lower
    // half of the cabinet renders black.
    this.marqueeLight = new PointLight(this.glow, 0, 6, 2)
    this.marqueeLight.position.set(0, mBottom + this.marqueeHeight / 2 - 0.12, 0.62)
    this.group.add(this.marqueeLight)

    // --- side art ---------------------------------------------------------
    // A cabinet has two flanks and they are different pictures. One on its own is mirrored onto both
    // rather than leaving a bare side, which is what happens while only half the art exists.
    // Mapped to the silhouette's bounding box, which is what ART.md tells the generator to draw to.
    for (const sign of [1, -1]) {
      const name = sign > 0 ? 'side-right' : 'side-left'
      const other = sign > 0 ? 'side-left' : 'side-right'
      const tex = art.texture(name) ?? art.texture(other)
      if (!tex) continue
      const mat = new MeshStandardMaterial({ map: tex, roughness: 0.55 })
      const geo = flankGeometry(this.marqueeHeight, totalH, sign, art.aspect(name) ?? art.aspect(other))
      this.group.add(new Mesh(geo, mat))
      this.owned.push(geo, mat)
    }

    // --- control deck and bezel -------------------------------------------
    const deckTex = art.texture('panel')
    if (deckTex) {
      const f = fitFace(recessed(lip), recessed(deckBack), INNER, art.aspect('panel'))
      const g = facePlane(f.a, f.b, f.width, 0.003)
      const m = new MeshStandardMaterial({ map: deckTex, roughness: 0.5, color: new Color().setScalar(DECK_ALBEDO) })
      this.group.add(new Mesh(g, m))
      this.owned.push(g, m)
    }

    // The controls themselves, in geometry rather than painted on. Artwork that has to leave holes
    // for a wheel and three buttons is artwork with holes in it, which is a hard thing to ask a
    // generator for and a worse thing to get slightly wrong. Real controls standing proud of the
    // deck also read as a cabinet from across the room, which a dark circle does not.
    const deck = faceFrame(recessed(lip), recessed(deckBack))
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
      // Flat in the control surface, not raked up out of it: an arcade wheel lies in the panel at
      // the panel's own angle, which is why you steer one with your palms rather than your arms.
      const wheel = new Mesh(rim, dark)
      wheel.position.set(...stand(0.022, -0.04, -0.02))
      wheel.rotation.x = deck.tilt
      this.group.add(wheel)
      const hubGeo = new CylinderGeometry(CAB.wheelRadius * 0.3, CAB.wheelRadius * 0.3, 0.012, 12)
      const hub = new Mesh(hubGeo, dark)
      hub.position.set(...stand(0.018, -0.04, -0.02))
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

      // Pedals, on a plate at the foot of the machine. The plate runs back *under* the base rather
      // than sitting out on the carpet in front of it: the base stands back from the control panel,
      // so a plate that starts at the front of the machine leaves a hand's width of floor showing
      // between the two and reads as a separate object someone left there.
      const plateGeo = new BoxGeometry(0.36, 0.022, 0.34)
      const plate = new Mesh(plateGeo, dark)
      plate.position.set(0, 0.011, 0.03)
      this.group.add(plate)
      // Hinged at the back and standing up at the front, which is what a pedal looks like from any
      // angle you can actually see one from.
      const pedalGeo = new BoxGeometry(0.082, 0.018, 0.15)
      for (const [px, tilt] of [
        [-0.085, -0.42],
        [0.085, -0.34],
      ]) {
        const pedal = new Mesh(pedalGeo, px < 0 ? dark : lit)
        pedal.position.set(px, 0.05, 0.1)
        pedal.rotation.x = tilt
        this.group.add(pedal)
      }
      this.owned.push(plateGeo, pedalGeo)
    }

    // --- speakers ---------------------------------------------------------
    // The panel raked forward over the monitor is a speaker baffle and nothing else; a cabinet
    // without the two grilles in it reads as a kiosk. Rings rather than holes, because they stand
    // proud of a face the artwork does not cover.
    const baffle = faceFrame(recessed(bezelTop), recessed(marqueeFoot))
    const grilleGeo = new CylinderGeometry(CAB.speakerRadius, CAB.speakerRadius, 0.012, 20)
    const coneGeo = new CylinderGeometry(CAB.speakerRadius * 0.55, CAB.speakerRadius * 0.72, 0.01, 16)
    for (const sx of [-1, 1]) {
      const at = (lift: number): [number, number, number] => [sx * CAB.speakerX, baffle.y + baffle.ny * lift, baffle.z + baffle.nz * lift]
      const ring = new Mesh(grilleGeo, dark)
      ring.position.set(...at(0.004))
      ring.rotation.x = baffle.tilt + Math.PI / 2
      this.group.add(ring)
      const cone = new Mesh(coneGeo, bodyMat)
      cone.position.set(...at(0.001))
      cone.rotation.x = baffle.tilt + Math.PI / 2
      this.group.add(cone)
    }
    this.owned.push(grilleGeo, coneGeo)

    const bezelTex = art.texture('bezel')
    this.bezelMat = bezelTex ? new MeshBasicMaterial({ map: bezelTex }) : null
    if (this.bezelMat) {
      const f = fitFace(recessed(bezelBottom), recessed(bezelTop), INNER, art.aspect('bezel'))
      const g = facePlane(f.a, f.b, f.width, 0.003)
      this.group.add(new Mesh(g, this.bezelMat))
      this.owned.push(g, this.bezelMat)
    }

    // --- screen -----------------------------------------------------------
    // Inside the bezel's opening: inset all round, and a touch further proud so it reads as glass
    // sitting in a frame rather than as another decal.
    const screenGeo = facePlane(screenBottom, screenTop, CAB.screen.w, bezelTex ? 0.005 : 0.004)
    art.fitAttractTo(CAB.screen.w / CAB.screen.h)
    const attract = art.attract()
    // With no attract art the screen is a dark pane rather than a hole: a touch of the game's own
    // colour, so an unfinished cabinet still looks switched on.
    this.screenMat = new MeshBasicMaterial({ map: attract, color: attract ? 0xffffff : new Color(game.body).multiplyScalar(0.5), toneMapped: false })
    const screenFace = faceFrame(screenBottom, screenTop)
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
    return CAB.marqueeBottom + this.marqueeHeight + CAB.topRise
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
    this.bezelMat?.color.setScalar(BEZEL_DIM.off + (BEZEL_DIM.on - BEZEL_DIM.off) * t)
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
