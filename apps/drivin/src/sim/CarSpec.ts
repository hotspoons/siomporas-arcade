// The car catalogue. One hero car today; the shape is what the garage grows
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
]

export function carById(id: string): CarSpec {
  return CARS.find((c) => c.id === id) ?? CARS[0]
}
