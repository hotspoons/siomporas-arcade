// Where a thing beside the road stands.
//
// ONE COPY, because there were two and they drifted. Built-in stages are scattered by `Road.ts` and
// authored tracks by `world/compile.ts`, and both had their own transcription of the same three
// rules. Fixing the offsets in one of them left the other putting diners in the road, which is
// exactly the failure this is meant to end — so the rules live here and both call in.
//
// The rules themselves are in `sideOffset` (render/models.ts): a kind stands clear of the tarmac by
// its own measured width, whatever the scene asked for.

import { MODEL_BY_KIND, sideOffset } from '../render/models'
import type { Segment } from './Road'
import { FORK_SPREAD } from './Tuning'

/**
 * How far out the ground the player can be on reaches, in road-halves, on this segment. One
 * everywhere except through a fork, where the two carriageways pull apart to ±`FORK_SPREAD` and the
 * road is briefly two and a half times its own width. Placement that does not know this puts a lamp
 * post in the right-hand carriageway of every fork — invisible in a screenshot of the straights,
 * and a crash every time the player takes that side.
 */
function edge(seg: Segment): number {
  return seg.fork >= 0 ? 1 + seg.fork * FORK_SPREAD : 1
}

/**
 * A scattered roadside sprite. `want` is how far back the theme likes this kind and `scale` the
 * size this one rolled; the offset returned is never closer to the road than the model allows.
 */
export function placeScenery(seg: Segment, kind: string, side: -1 | 1, want: number, scale: number, collide: boolean): void {
  seg.sprites.push({ kind, offset: side * (sideOffset(kind, want, scale) + edge(seg) - 1), scale, collide })
}

/**
 * A landmark: a building, a sign, an arch. A kind that spans the road goes over the centreline and
 * is not something you can hit — an arch pushed onto the verge like a diner is half an arch in a
 * field, which is what both scatterers used to do with it.
 */
export function placeLandmark(seg: Segment, kind: string, side: -1 | 1): void {
  if (MODEL_BY_KIND[kind]?.straddle) seg.sprites.push({ kind, offset: 0, scale: 1, collide: false })
  else seg.sprites.push({ kind, offset: side * (sideOffset(kind) + edge(seg) - 1), scale: 1, collide: true })
}

/**
 * A hand-placed prop keeps the side it was dragged to and is pushed out to its own clearance.
 * `offset: 0` is left alone: it means "over the centreline", which is where a gantry belongs.
 */
export function placeAt(seg: Segment, kind: string, offset: number, scale: number, collide: boolean): void {
  const out = offset === 0 || MODEL_BY_KIND[kind]?.straddle ? 0 : Math.sign(offset) * (sideOffset(kind, Math.abs(offset), scale) + edge(seg) - 1)
  seg.sprites.push({ kind, offset: out, scale, collide })
}
