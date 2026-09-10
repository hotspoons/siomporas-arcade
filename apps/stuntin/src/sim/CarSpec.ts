// The car catalogue. The hero car and one built for the speedbowl; the shape is what the garage grows
// from later (name, handling numbers, and a look the renderer interprets).

export interface CarLook {
  body: number
  accent: number
  glass: number
  /** Body silhouette family the renderer knows how to build. */
  shape: 'wedge' | 'coupe'
}

export interface CarSpec {
  id: string
  name: string
  /** m/s. */
  topSpeed: number
  /** m/s² at low speed. */
  accel: number
  /** m/s². */
  brake: number
  /** Multiplier on GRIP_LATERAL. */
  grip: number
  /** Multiplier on steering authority. */
  agility: number
  look: CarLook
}

export const CARS: CarSpec[] = [
  {
    id: 'kestrel',
    name: 'Kestrel S9',
    topSpeed: 82,
    accel: 11,
    brake: 24,
    grip: 1.0,
    agility: 1.0,
    look: { body: 0xff7a1a, accent: 0x111111, glass: 0x1a2a3a, shape: 'wedge' },
  },
  {
    // For the speedbowl. The Kestrel tops out at 183 mph, which is under what the bowl's wall will
    // now hold, so there is something to hold: this one will do three hundred if the road is long
    // enough to get there, and it wants the banking to do it — it is slower to turn and slower to
    // build speed, so the flat parts of a track are no faster in it.
    id: 'comet',
    name: 'Comet 300',
    topSpeed: 134,
    accel: 8,
    brake: 26,
    grip: 1.05,
    agility: 0.8,
    look: { body: 0x2ad6ff, accent: 0x0a1020, glass: 0x14243a, shape: 'coupe' },
  },
]

export function carById(id: string): CarSpec {
  return CARS.find((c) => c.id === id) ?? CARS[0]
}
