export interface InputFrame {
  steer: number
  throttle: number
  brake: number
  /** Edge: toggle hi/lo gear. */
  gear: boolean
  /** Edge: fire turbo. */
  turbo: boolean
  /** Edges: wipers and headlights are manual, like the arcade. */
  wipers: boolean
  lights: boolean
}

export function makeInputFrame(): InputFrame {
  return { steer: 0, throttle: 0, brake: 0, gear: false, turbo: false, wipers: false, lights: false }
}

export function copyInput(a: InputFrame, b: InputFrame): void {
  b.steer = a.steer
  b.throttle = a.throttle
  b.brake = a.brake
  b.gear = a.gear
  b.turbo = a.turbo
  b.wipers = a.wipers
  b.lights = a.lights
}
