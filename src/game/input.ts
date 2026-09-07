// Keyboard + gamepad + touch, flattened into one poll-per-frame struct. The
// sim never listens for events itself — it reads this, which keeps the physics
// step pure enough to stub out in a test.

export interface InputState {
  /** -1 (roll left) … +1 (roll right). */
  steer: number
  thrust: boolean
  brake: boolean
  boost: boolean
  /** True for exactly one frame per press — consumed by `consumeJump()`. */
  jump: boolean
  /** Any "start / retry" press, also one frame. */
  confirm: boolean
}

const keys = new Set<string>()
let jumpEdge = false
let confirmEdge = false
let touchSteer = 0
let touchThrust = false

const STEER_KEYS_L = ['ArrowLeft', 'KeyA']
const STEER_KEYS_R = ['ArrowRight', 'KeyD']

export const input: InputState = {
  steer: 0,
  thrust: false,
  brake: false,
  boost: false,
  jump: false,
  confirm: false,
}

function onKeyDown(e: KeyboardEvent) {
  // Space scrolls the page and Arrow keys scroll it too — the canvas is the
  // whole app, so nothing here should ever reach the document's scroller.
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
  if (e.repeat) return
  keys.add(e.code)
  if (e.code === 'Space') jumpEdge = true
  if (e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyR') confirmEdge = true
}

function onKeyUp(e: KeyboardEvent) {
  keys.delete(e.code)
}

function onBlur() {
  // Held keys would otherwise stick on alt-tab and fly you into a wall.
  keys.clear()
  touchSteer = 0
  touchThrust = false
}

function onPointer(e: PointerEvent) {
  if (e.pointerType === 'mouse') return
  if (e.type === 'pointerup' || e.type === 'pointercancel') {
    touchSteer = 0
    touchThrust = false
    return
  }
  // Touch: horizontal position steers, and any contact means thrust — a
  // one-thumb control scheme. Tap the top third to hop.
  const half = window.innerWidth / 2
  touchSteer = Math.max(-1, Math.min(1, (e.clientX - half) / (half * 0.6)))
  touchThrust = true
  if (e.type === 'pointerdown') {
    if (e.clientY < window.innerHeight / 3) jumpEdge = true
    confirmEdge = true
  }
}

export function attachInput(): () => void {
  window.addEventListener('keydown', onKeyDown, { passive: false })
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  window.addEventListener('pointerdown', onPointer)
  window.addEventListener('pointermove', onPointer)
  window.addEventListener('pointerup', onPointer)
  window.addEventListener('pointercancel', onPointer)
  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('pointerdown', onPointer)
    window.removeEventListener('pointermove', onPointer)
    window.removeEventListener('pointerup', onPointer)
    window.removeEventListener('pointercancel', onPointer)
    keys.clear()
  }
}

/** Refresh `input` from every source. Call once at the top of the frame. */
export function pollInput(): InputState {
  let steer = 0
  if (STEER_KEYS_L.some((k) => keys.has(k))) steer -= 1
  if (STEER_KEYS_R.some((k) => keys.has(k))) steer += 1
  let thrust = keys.has('ArrowUp') || keys.has('KeyW')
  let brake = keys.has('ArrowDown') || keys.has('KeyS')
  let boost = keys.has('ShiftLeft') || keys.has('ShiftRight')
  let jump = jumpEdge
  let confirm = confirmEdge

  const pad = navigator.getGamepads?.().find((p) => p?.connected)
  if (pad) {
    const ax = pad.axes[0] ?? 0
    if (Math.abs(ax) > 0.15) steer += ax
    thrust = thrust || (pad.buttons[7]?.pressed ?? false) || (pad.buttons[0]?.pressed ?? false)
    brake = brake || (pad.buttons[6]?.pressed ?? false)
    boost = boost || (pad.buttons[1]?.pressed ?? false)
    jump = jump || (pad.buttons[2]?.pressed ?? false)
    confirm = confirm || (pad.buttons[9]?.pressed ?? false) || (pad.buttons[0]?.pressed ?? false)
  }

  if (touchSteer !== 0) steer += touchSteer
  if (touchThrust) thrust = true

  input.steer = Math.max(-1, Math.min(1, steer))
  input.thrust = thrust
  input.brake = brake
  input.boost = boost
  input.jump = jump
  input.confirm = confirm
  jumpEdge = false
  confirmEdge = false
  return input
}
