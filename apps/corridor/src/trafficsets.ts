// A traffic set: which vehicles the traffic is made of, and in what proportion.
//
// Rich, 2026-09-29: *"Need to be able to select vehicles to comprise traffic too - not sure that's
// hooked up, maybe we have a traffic asset that just groups selected vehicles using the ecs to
// organize and link."*
//
// THIS IS THE FOURTH BUILD, and deliberately the same shape as the other three. A vehicle is a model
// plus dynamics; an actor is a model plus behaviour; a weapon is a model plus ballistics; a TRAFFIC
// SET is a list of vehicles plus how common each one is. It lives in the same `builds` collection
// machinery, is edited by the same screen, and is named by a level the same way — so there is one
// idea to learn rather than four.
//
// WEIGHTS, NOT COUNTS. "Six saloons and two vans" stops making sense the moment the road is longer
// or the density is higher; "saloons are three times as common as vans" survives both. The spawner
// asks for a vehicle and gets one drawn from the weights, so the mix is right at every density.
//
// THE ECS IS WHERE IT ENDS UP, which is the part of Rich's ask that matters: a spawned car gets a
// `MemberOf` relation to the set's entity, so everything downstream can ask "what is this car part
// of" and a program can address a whole fleet at once — make the taxis aggressive, remove the
// lorries, count how many of the set are still moving.

import type { VehicleDoc } from './vehicles'

export interface TrafficMember {
  /** the id of a vehicle BUILD — `builds('vehicles')`, not a catalog row */
  vehicle: string
  /**
   * How common it is, relative to the others. Any positive number; they are normalised, so 3 and 1
   * mean the same as 75 and 25.
   */
  weight: number
  /** override the set's own driver population for this one vehicle */
  obeyRate?: number
}

export interface TrafficSetDoc {
  /** the vehicles, and how common each is */
  mix: TrafficMember[]
  /**
   * The share of these drivers who stop for a light they could run, 0…1.
   *
   * On the SET as well as on the zone because it is a property of a population — a set of taxis is
   * driven differently from a set of family cars wherever it is placed — and a zone's own value
   * wins where both are given.
   */
  obeyRate?: number
  /** multiplier on the posted limit for this population */
  speedFactor?: number
}

export const EMPTY_SET: TrafficSetDoc = { mix: [] }

/** The weights, normalised to sum to one. Empty for an empty mix. */
export function shares(doc: TrafficSetDoc): { vehicle: string; share: number }[] {
  const ok = (doc.mix ?? []).filter((m) => m.vehicle && Number.isFinite(m.weight) && m.weight > 0)
  const total = ok.reduce((a, m) => a + m.weight, 0)
  if (!total) return []
  return ok.map((m) => ({ vehicle: m.vehicle, share: m.weight / total }))
}

/**
 * Draw one vehicle from the mix.
 *
 * `rand` is the caller's seeded generator — the same one that populates a road — so a level's
 * traffic is the same traffic twice. Null for an empty set, which is a real state: a set somebody
 * has made and not yet filled must not silently become a default car.
 */
export function pick(doc: TrafficSetDoc, rand: () => number): string | null {
  const s = shares(doc)
  if (!s.length) return null
  let r = Math.max(0, Math.min(1, rand()))
  for (const m of s) {
    r -= m.share
    if (r <= 0) return m.vehicle
  }
  return s[s.length - 1].vehicle
}

/**
 * How many of each you would expect in `n` cars.
 *
 * For the editor's readout. Rounded, so it will not always sum to `n` — which is honest: the mix is
 * a probability, and showing "6.4 saloons" would be pretending otherwise.
 */
export function expected(doc: TrafficSetDoc, n: number): { vehicle: string; count: number }[] {
  return shares(doc).map((m) => ({ vehicle: m.vehicle, count: Math.round(m.share * n) }))
}

/** One line for a card: what this set is. */
export function describeSet(doc: TrafficSetDoc): string {
  const s = shares(doc)
  if (!s.length) return 'no vehicles yet'
  const top = [...s].sort((a, b) => b.share - a.share).slice(0, 3)
  const bits = top.map((m) => `${Math.round(m.share * 100)}% ${m.vehicle}`)
  if (s.length > 3) bits.push(`+${s.length - 3} more`)
  return bits.join(' · ')
}

/**
 * Every problem, not the first.
 *
 * `vehicles` is the list of vehicle builds that exist. Passing it turns "names a vehicle nobody has
 * built" from an invisible failure — a spawner that silently falls back to a default car — into an
 * error on the form.
 */
export function validateSet(doc: TrafficSetDoc | null | undefined, opts: { vehicles?: string[] } = {}): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!doc) return { ok: true, errors, warnings }
  const seen = new Set<string>()
  for (const [i, m] of (doc.mix ?? []).entries()) {
    const where = m.vehicle ? `${m.vehicle}` : `mix[${i}]`
    if (!m.vehicle) errors.push(`${where} has no vehicle chosen`)
    else if (seen.has(m.vehicle)) errors.push(`${m.vehicle} is in the mix twice — give it one weight instead`)
    else seen.add(m.vehicle)
    if (m.vehicle && opts.vehicles && !opts.vehicles.includes(m.vehicle)) {
      errors.push(`${m.vehicle} is not a vehicle anybody has built`)
    }
    if (!Number.isFinite(m.weight) || m.weight <= 0) errors.push(`${where} needs a weight above zero`)
    if (m.obeyRate !== undefined && (m.obeyRate < 0 || m.obeyRate > 1)) errors.push(`${where} obeyRate must be between 0 and 1`)
  }
  if (!(doc.mix ?? []).length) warnings.push('an empty set spawns nothing — add the vehicles this traffic is made of')
  if (doc.obeyRate !== undefined && (doc.obeyRate < 0 || doc.obeyRate > 1)) errors.push('obeyRate must be between 0 and 1')
  if (doc.speedFactor !== undefined && !(doc.speedFactor > 0)) errors.push('speedFactor must be a positive number')
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * The starting points, the same idea as the vehicle and actor presets.
 *
 * They name vehicle BUILD ids that a given world may or may not have, so every one is a suggestion
 * rather than a promise — the editor filters them to what exists, and `validateSet` says so when
 * one does not.
 */
export interface TrafficSetPreset {
  id: string
  name: string
  note: string
  doc: TrafficSetDoc
}

export const TRAFFIC_SET_PRESETS: TrafficSetPreset[] = [
  {
    id: 'ordinary',
    name: 'Ordinary road',
    note: 'Mostly family cars, a few vans, the occasional lorry. What a county road looks like.',
    doc: { mix: [{ vehicle: 'traffic', weight: 70 }, { vehicle: 'van', weight: 20 }, { vehicle: 'box-truck', weight: 10 }], obeyRate: 0.97 },
  },
  {
    id: 'city',
    name: 'City centre',
    note: 'Taxis, vans and buses. Slower, and rather less patient about the lights.',
    doc: { mix: [{ vehicle: 'taxi', weight: 40 }, { vehicle: 'traffic', weight: 35 }, { vehicle: 'van', weight: 15 }, { vehicle: 'bus', weight: 10 }], obeyRate: 0.9, speedFactor: 0.85 },
  },
  {
    id: 'freight',
    name: 'Freight route',
    note: 'Lorries and vans with a scattering of cars. Slow to start and slower to stop.',
    doc: { mix: [{ vehicle: 'box-truck', weight: 45 }, { vehicle: 'van', weight: 30 }, { vehicle: 'traffic', weight: 25 }], obeyRate: 0.98, speedFactor: 0.9 },
  },
  {
    id: 'deserted',
    name: 'Nearly deserted',
    note: 'One kind of car and not many of them — for a stage where the traffic is scenery.',
    doc: { mix: [{ vehicle: 'traffic', weight: 1 }], obeyRate: 1 },
  },
]

export function trafficSetPreset(id: string): TrafficSetPreset | null {
  return TRAFFIC_SET_PRESETS.find((p) => p.id === id) ?? null
}

/** A fresh copy, never the module's own object. */
export function trafficSetPresetDoc(id: string): TrafficSetDoc | null {
  const p = trafficSetPreset(id)
  return p ? structuredClone(p.doc) : null
}

/** What a set's vehicles weigh on average, for a readout — needs the vehicle documents. */
export function averageMass(doc: TrafficSetDoc, docs: Record<string, VehicleDoc>): number | null {
  const s = shares(doc)
  let sum = 0
  let known = 0
  for (const m of s) {
    const v = docs[m.vehicle]
    if (!v?.spec?.mass) continue
    sum += v.spec.mass * m.share
    known += m.share
  }
  return known > 0 ? sum / known : null
}
