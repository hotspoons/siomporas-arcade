// Per-tick input for the car.

export interface InputFrame {
  /** -1 left … +1 right. */
  steer: number
  throttle: number
  brake: number
  handbrake: boolean
  /** Edge: reset to the last piece. */
  reset: boolean
}

export function makeInputFrame(): InputFrame {
  return { steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false }
}

export function copyInput(from: InputFrame, to: InputFrame): void {
  to.steer = from.steer
  to.throttle = from.throttle
  to.brake = from.brake
  to.handbrake = from.handbrake
  to.reset = from.reset
}
