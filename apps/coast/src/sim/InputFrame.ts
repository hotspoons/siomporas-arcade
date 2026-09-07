export interface InputFrame {
  steer: number
  throttle: number
  brake: number
  /** Edge: toggle hi/lo gear. */
  gear: boolean
  /** Edge: fire turbo. */
  turbo: boolean
}

export function makeInputFrame(): InputFrame {
  return { steer: 0, throttle: 0, brake: 0, gear: false, turbo: false }
}

export function copyInput(a: InputFrame, b: InputFrame): void {
  b.steer = a.steer
  b.throttle = a.throttle
  b.brake = a.brake
  b.gear = a.gear
  b.turbo = a.turbo
}
