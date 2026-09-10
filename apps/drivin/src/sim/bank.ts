// The wall a speedbowl grows past the edge of its road.
//
// A banked piece is a flat deck rolled over: ten metres wide at one angle, and once you are at the
// outer edge there is nowhere further to go. That caps the corner — the tyres hold a fixed budget of
// grip, banking adds a little, and past about 160 mph you run out of both. A real speedbowl does not
// work like that. Its outside keeps curving up, and the faster you go the higher you ride, until you
// are running along something close to a wall with the corner pressing you into it.
//
// So a banked piece can declare a wall: past the road's edge, on the outer side, the surface curves
// on through an arc until it stands at `wallTo` from horizontal. Everything that asks where the
// surface is at a given offset across the road — the car's pose, its collisions, the road mesh —
// asks through here, so the wall exists once rather than in four places that can disagree.
//
// Lateral offsets stay arc length along the surface, exactly as they are on a tube, so `lateral` is
// still "how far across the road am I" and nothing downstream has to learn a new coordinate.

import { ROAD_HALF_WIDTH } from './Tuning'

export interface Bank {
  /** How far from horizontal the top of the wall stands, in radians. */
  wallTo: number
  /** The radius the wall curves through on its way there: tighter is a sharper lip. */
  radius: number
  /**
   * Metres of wall past that curve, running straight on at the same angle. The curve is the
   * transition; this is the lane. Without it the whole wall is spent turning and there is nowhere
   * to sit at the angle the wall is for.
   */
  run: number
}

/** Where a point across the road sits, and how the surface is tilted under it. */
export interface Across {
  /** Offset along the frame's right, in metres. */
  out: number
  /** Offset along the frame's up, in metres. */
  lift: number
  /**
   * Extra tilt of the surface here, signed the way a tube's is: the local up is
   * `up·cos(a) − right·sin(a)`, so positive leans the surface up on the +right side.
   */
  a: number
}

/**
 * The wall climbs on whichever side the deck already rises towards — the outside of the corner, which
 * is the side the frame's right points downhill on — and how much of it there is to climb is whatever
 * is left between the deck's own angle and the angle the wall stands at. A flat lane has no outside
 * and no wall; a deck already past `wallTo` has nothing left to add.
 *
 * Both come out of the frame itself rather than being carried alongside it, so banking that ramps in
 * and out at the ends of a piece grows and loses its wall with it, and a mirrored piece gets its wall
 * on the other side without being told.
 */
export function wallOf(bank: Bank | undefined, rightY: number): { side: -1 | 0 | 1; maxA: number } {
  const side = rightY < -1e-3 ? -1 : rightY > 1e-3 ? 1 : 0
  if (!bank || side === 0) return { side: 0, maxA: 0 }
  const roll = Math.abs(Math.asin(Math.max(-1, Math.min(1, rightY))))
  return { side, maxA: Math.max(0, bank.wallTo - roll) }
}

/** The furthest across the road the surface goes on a given side: the top of the wall, or the edge. */
export function edgeOf(bank: Bank | undefined, rightY: number, sign: number): number {
  const { side, maxA } = wallOf(bank, rightY)
  return ROAD_HALF_WIDTH + (side !== 0 && Math.sign(sign) === side ? maxA * bank!.radius + bank!.run : 0)
}

/**
 * Resolve a lateral offset into a place on the surface. Inside the road it is the flat deck; past the
 * edge on the wall's side it is the arc, and past the top of the arc it carries straight on at that
 * angle so there is no cliff at the lip.
 */
export function sectionAt(bank: Bank | undefined, rightY: number, x: number, out: Across): Across {
  out.out = x
  out.lift = 0
  out.a = 0
  const { side, maxA } = wallOf(bank, rightY)
  if (!bank || side === 0 || maxA <= 0) return out
  const d = side * x - ROAD_HALF_WIDTH
  if (d <= 0) return out
  const a = Math.min(d / bank.radius, maxA)
  let along = ROAD_HALF_WIDTH + bank.radius * Math.sin(a)
  let lift = bank.radius * (1 - Math.cos(a))
  const past = d - a * bank.radius
  if (past > 0) {
    along += past * Math.cos(a)
    lift += past * Math.sin(a)
  }
  out.out = side * along
  out.lift = lift
  out.a = side * a
  return out
}

/** A scratch result, for the callers that run this every tick. */
export function makeAcross(): Across {
  return { out: 0, lift: 0, a: 0 }
}

/**
 * The same wall, resolved the other way round: from an offset measured *across the frame* rather
 * than along the surface.
 *
 * The car carries `lateral` as arc length — how far it has driven across the road, wall included —
 * but anything that projects a point of the world onto a lane gets a flat offset along the frame's
 * right instead. Nine metres up a near-vertical wall is nine metres of arc and about three metres of
 * offset, so the two coordinates have to be told apart or a car beside a speedbowl is measured
 * against a wall that reaches far further than it does.
 */
export function sectionAtOut(bank: Bank | undefined, rightY: number, outX: number, out: Across): Across {
  out.out = outX
  out.lift = 0
  out.a = 0
  const { side, maxA } = wallOf(bank, rightY)
  if (!bank || side === 0 || maxA <= 0) return out
  const d = side * outX - ROAD_HALF_WIDTH
  if (d <= 0) return out
  const reach = bank.radius * Math.sin(maxA)
  if (d <= reach) {
    const a = Math.asin(Math.min(1, d / bank.radius))
    out.lift = bank.radius * (1 - Math.cos(a))
    out.a = side * a
    return out
  }
  // Past the top of the arc the wall carries straight on at that angle.
  out.lift = bank.radius * (1 - Math.cos(maxA)) + ((d - reach) / Math.max(1e-3, Math.cos(maxA))) * Math.sin(maxA)
  out.a = side * maxA
  return out
}

/** How far across the frame the surface reaches on a side — the planar twin of `edgeOf`. */
export function outEdgeOf(bank: Bank | undefined, rightY: number, sign: number): number {
  const { side, maxA } = wallOf(bank, rightY)
  if (side === 0 || Math.sign(sign) !== side) return ROAD_HALF_WIDTH
  return ROAD_HALF_WIDTH + bank!.radius * Math.sin(maxA) + bank!.run * Math.cos(maxA)
}

/** Arc length across the surface for a flat offset across the frame: what `landOn` needs. */
export function arcFromOut(bank: Bank | undefined, rightY: number, outX: number, scratch: Across): number {
  const sec = sectionAtOut(bank, rightY, outX, scratch)
  if (sec.a === 0) return outX
  const side = Math.sign(sec.a)
  const d = side * outX - ROAD_HALF_WIDTH
  const reach = (bank?.radius ?? 0) * Math.sin(Math.abs(sec.a))
  const arc = (bank?.radius ?? 0) * Math.abs(sec.a) + Math.max(0, d - reach) / Math.max(1e-3, Math.cos(sec.a))
  return side * (ROAD_HALF_WIDTH + arc)
}
