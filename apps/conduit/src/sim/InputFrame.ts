// What the sim consumes each tick. Produced by the input layer once per frame
// and held for every sub-tick of that frame; edges are consumed by the sim.

export interface InputFrame {
  /** -1 (left) … +1 (right). Positive steer increases theta = moves right. */
  steer: number
  /** 0..1 analog. */
  throttle: number
  /** 0..1 analog. */
  brake: number
  fire: boolean
  /** Edge: true for the frame it was pressed. */
  shockwave: boolean
  /** -1..1 airborne pitch (up is positive). */
  pitch: number
}

export function makeInputFrame(): InputFrame {
  return { steer: 0, throttle: 0, brake: 0, fire: false, shockwave: false, pitch: 0 }
}

export function copyInput(from: InputFrame, to: InputFrame): void {
  to.steer = from.steer
  to.throttle = from.throttle
  to.brake = from.brake
  to.fire = from.fire
  to.shockwave = from.shockwave
  to.pitch = from.pitch
}

/** Pack to a compact record for the replay tape. */
export function encodeInput(f: InputFrame): number {
  // steer 8 bits, throttle 4, brake 4, flags 2, pitch 8 — enough for a tape.
  const st = Math.round((f.steer * 0.5 + 0.5) * 255) & 0xff
  const th = Math.round(f.throttle * 15) & 0xf
  const br = Math.round(f.brake * 15) & 0xf
  const fl = (f.fire ? 1 : 0) | (f.shockwave ? 2 : 0)
  const pi = Math.round((f.pitch * 0.5 + 0.5) * 255) & 0xff
  return st | (th << 8) | (br << 12) | (fl << 16) | (pi << 18)
}

export function decodeInput(v: number, out: InputFrame): InputFrame {
  out.steer = ((v & 0xff) / 255) * 2 - 1
  out.throttle = ((v >>> 8) & 0xf) / 15
  out.brake = ((v >>> 12) & 0xf) / 15
  out.fire = ((v >>> 16) & 1) === 1
  out.shockwave = ((v >>> 16) & 2) === 2
  out.pitch = (((v >>> 18) & 0xff) / 255) * 2 - 1
  return out
}
