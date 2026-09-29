// Which of these four bones is the near-side front wheel?
//
// The physics lane asked for this on 2026-09-28, and the reason is worth keeping: "nothing
// downstream can ever detect a wrong order. I can count bones; I cannot tell a front-left from a
// rear-left. Four bones in the wrong sequence produces a car that steers with its back wheels and
// drives with its front ones — which reads as 'the handling feels weird', gets blamed on the
// profile, and could burn a day before anybody suspects the rig."
//
// So the editor has four labelled slots rather than a tick order, and this fills them from where
// the bones actually are. Geometry is used for the SPLIT — which two bones share an end, which two
// share a side — because that part is certain: four wheels are a rectangle and nothing else in the
// model is. Geometry cannot say which end is the front; that is a fact about the car, not about
// the numbers. Names answer it when they say anything, and when they do not the editor offers
// two swap buttons over a model you are looking at.
//
// NOTHING HERE ASSUMES AN AXIS CONVENTION. A glb carries whatever the exporter felt like — Z-up
// out of Blender, Y-up through most pipelines, forward along +X or -Z depending on the decade —
// and a hard-coded "+X is forward" is exactly the silent wrong answer this exists to prevent.

export interface Place { x: number, y: number, z: number }

/** FL, FR, RL, RR — the order `vehicles.ts` reads out of `rig.roles.wheel`. */
export const WHEEL_SLOTS = ['FL', 'FR', 'RL', 'RR'] as const
export type WheelSlot = typeof WHEEL_SLOTS[number]

export interface SlotGuess {
  /** bone names in FL, FR, RL, RR order */
  order: [string, string, string, string]
  /** what the axes came out as, for the editor to show rather than hide */
  note: string
  /** true when a name said which end was the front, false when +longitudinal was assumed */
  oriented: boolean
}

const AX = ['x', 'y', 'z'] as const
const at = (p: Place, i: number): number => p[AX[i]]

/** e_a x e_b, for basis vectors: which axis it lands on and with what sign. */
function cross(a: number, b: number): { axis: number, sign: number } {
  const axis = 3 - a - b
  // x,y,z is a right-handed cycle: x*y=+z, y*z=+x, z*x=+y; the reverse of each is negative
  const sign = (b - a + 3) % 3 === 1 ? 1 : -1
  return { axis, sign }
}

/** fl / f_l / FrontLeft / wheel.RR … — loose on purpose, exporters disagree about everything. */
function nameSays(raw: string): { front?: boolean, left?: boolean } {
  const n = raw.toLowerCase()
  const out: { front?: boolean, left?: boolean } = {}
  if (/(^|[^a-z])(fl|lf)([^a-z]|$)/.test(n)) return { front: true, left: true }
  if (/(^|[^a-z])(fr|rf)([^a-z]|$)/.test(n)) return { front: true, left: false }
  if (/(^|[^a-z])(rl|lr|bl)([^a-z]|$)/.test(n)) return { front: false, left: true }
  if (/(^|[^a-z])(rr|br)([^a-z]|$)/.test(n)) return { front: false, left: false }
  if (/front|fore/.test(n)) out.front = true
  else if (/rear|back|aft/.test(n)) out.front = false
  if (/left|near|[^a-z]l([^a-z]|$)/.test(n)) out.left = true
  else if (/right|off|[^a-z]r([^a-z]|$)/.test(n)) out.left = false
  return out
}

const spread = (v: number[]): number => Math.max(...v) - Math.min(...v)

/**
 * Sort four wheel bones into FL, FR, RL, RR.
 *
 * Returns null when there are not exactly four with known positions — four labelled slots half
 * filled is a question for a person, and guessing at three of them would be the same silent wrong
 * answer in a smaller package.
 */
export function guessWheelSlots(names: string[], places: Record<string, Place>): SlotGuess | null {
  const known = names.filter((n) => places[n])
  if (known.length !== 4) return null
  const pts = known.map((n) => places[n])

  // The up axis is the one the four barely differ on: wheels sit on the road, whatever "up" is
  // called in this file. The longer of the other two is the wheelbase — every road vehicle is
  // longer between the axles than it is wide across them, and the ones that are not are not cars.
  const spreads = [0, 1, 2].map((i) => spread(pts.map((p) => at(p, i))))
  const up = spreads.indexOf(Math.min(...spreads))
  const rest = [0, 1, 2].filter((i) => i !== up)
  const lon = spreads[rest[0]] >= spreads[rest[1]] ? rest[0] : rest[1]
  const lat = rest[0] === lon ? rest[1] : rest[0]

  // A rectangle, or four bones in a row? Every road vehicle's track is between about a third of
  // its wheelbase (a bus) and three quarters (a sports car); a tenth is not a vehicle, it is four
  // bones strung along the centreline, and splitting THOSE left from right gives four confident
  // corners from a centimetre of noise. Refusing is the only honest answer.
  if (spreads[lat] < spreads[lon] * 0.2) return null

  // Start by calling +longitudinal the front, then let the names overrule it.
  let fSign = 1
  const said = known.map((n) => nameSays(n))
  const lonOf = (i: number) => at(pts[i], lon)
  const midLon = (Math.max(...pts.map((p) => at(p, lon))) + Math.min(...pts.map((p) => at(p, lon)))) / 2
  let oriented = false
  let votes = 0
  for (let i = 0; i < 4; i++) {
    if (said[i].front === undefined) continue
    votes += said[i].front === (lonOf(i) > midLon) ? 1 : -1
  }
  if (votes !== 0) { fSign = votes > 0 ? 1 : -1; oriented = true }

  // Left is up x forward. Which way "up" points is another thing a glb does not promise, so this
  // is a guess too — but it is a guess the editor shows, with a swap beside it.
  const l = cross(up, lon)
  let lSign = l.sign * fSign
  const latMid = (Math.max(...pts.map((p) => at(p, lat))) + Math.min(...pts.map((p) => at(p, lat)))) / 2
  let lVotes = 0
  for (let i = 0; i < 4; i++) {
    if (said[i].left === undefined) continue
    lVotes += said[i].left === (at(pts[i], lat) * lSign > latMid * lSign) ? 1 : -1
  }
  if (lVotes < 0) lSign = -lSign

  const slotOf = (i: number): WheelSlot => {
    const front = (lonOf(i) - midLon) * fSign > 0
    const left = (at(pts[i], lat) - latMid) * lSign > 0
    return front ? (left ? 'FL' : 'FR') : left ? 'RL' : 'RR'
  }
  const by: Partial<Record<WheelSlot, string>> = {}
  for (let i = 0; i < 4; i++) {
    const s = slotOf(i)
    if (by[s]) return null // two bones landed in one corner: the rectangle is not a rectangle
    by[s] = known[i]
  }
  if (WHEEL_SLOTS.some((s) => !by[s])) return null
  return {
    order: WHEEL_SLOTS.map((s) => by[s]!) as [string, string, string, string],
    note: `${fSign > 0 ? '+' : '−'}${AX[lon]} is the front, ${AX[up]} is up`,
    oriented,
  }
}

/** Swap the two ends (FL,FR,RL,RR -> RL,RR,FL,FR). */
export function swapEnds(o: readonly string[]): [string, string, string, string] {
  return [o[2], o[3], o[0], o[1]] as [string, string, string, string]
}

/** Swap the two sides (FL,FR,RL,RR -> FR,FL,RR,RL). */
export function swapSides(o: readonly string[]): [string, string, string, string] {
  return [o[1], o[0], o[3], o[2]] as [string, string, string, string]
}
