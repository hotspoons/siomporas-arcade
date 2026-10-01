// Keyboard and gamepad → the car's pedals, the free camera's sticks, the menus' edges.
//
// The viewer grew up on DOM key events: a `keydown` switch for the hotkeys and a `held` set for
// the pedals. That stays for the keyboard — it is what respects a focused text field and the
// shell's own Escape — and this file adds the things a set of key codes cannot give:
//
//   bindings      an ACTION, not a key. `actionOf(code)` is what the keydown switch now asks, so
//                 rebinding a key in the Escape menu changes what the switch does.
//   the gamepad   polled once a frame from `navigator.getGamepads()` (the engine's GamepadSource);
//                 analog triggers as pedals, the stick as steering, buttons as the same actions.
//   menu edges    up/down/left/right with auto-repeat, confirm and back, for MenuStack.handle().
//   haptics       the engine's Haptics over the same pad, with the strength from settings.
//
// The keyboard tracker here is deliberately NOT the engine's KeyboardSource: that one
// preventDefaults Space and the arrows on every keydown, focused input or not, which would break
// typing a space into the search box and arrowing a slider in the settings dialog. This one
// skips fields and prevents nothing; `main.ts` already prevents what it must while driving.
import { GamepadSource } from '@apex/engine/input/GamepadSource'
import { Haptics } from '@apex/engine/input/Haptics'
import type { KeyBindings, PadBindings } from '@apex/engine/input/bindings'
import { makeUiEdges, type UiEdges } from '@apex/engine/input/UiEdges'
import type { Action } from './gamesettings'

/** the pedals, as `CarInput` wants them */
export interface DriveRead {
  steer: number
  throttle: number
  brake: number
  handbrake: boolean
}

/** the right stick while driving: a look round the car that lets go */
export interface LookRead {
  /** -1…1, + right */
  x: number
  /** -1…1, + up */
  y: number
  /** the stick is off centre */
  active: boolean
}

/** the free camera's sticks: move in the camera's horizontal frame, look about the camera */
export interface FlyRead {
  fwd: number
  side: number
  up: number
  lookYaw: number
  lookPitch: number
}

/** the keys, with an edge set and `onAny` for BindingCapture; `KeyDownSource`-shaped */
export class KeyTracker {
  readonly down = new Set<string>()
  private edges = new Set<string>()
  private frameEdges = new Set<string>()
  lastCode = ''
  onAny: ((code: string) => void) | null = null

  attach(target: Window): void {
    target.addEventListener('keydown', this.onKeyDown)
    target.addEventListener('keyup', this.onKeyUp)
    target.addEventListener('blur', this.onBlur)
  }

  detach(target: Window): void {
    target.removeEventListener('keydown', this.onKeyDown)
    target.removeEventListener('keyup', this.onKeyUp)
    target.removeEventListener('blur', this.onBlur)
  }

  isDown(code: string): boolean {
    return this.down.has(code)
  }

  wasPressed(code: string): boolean {
    return this.edges.has(code) || this.frameEdges.has(code)
  }

  beginFrame(): void {
    this.frameEdges.clear()
  }

  /** any key went down this frame */
  get anyEdge(): boolean {
    return this.edges.size > 0 || this.frameEdges.size > 0
  }

  endFrame(): void {
    for (const c of this.edges) this.frameEdges.add(c)
    this.edges.clear()
  }

  /** a press from somewhere other than the DOM — a test, or the touch pads */
  press(code: string): void {
    if (!this.down.has(code)) {
      this.edges.add(code)
      this.lastCode = code
      this.onAny?.(code)
    }
    this.down.add(code)
  }

  release(code: string): void {
    this.down.delete(code)
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || typing(e.target)) return
    this.press(e.code)
  }
  private readonly onKeyUp = (e: KeyboardEvent) => this.release(e.code)
  private readonly onBlur = () => this.down.clear()
}

/** True when the keystroke belongs to a text field, and the game should keep its hands off. */
export function typing(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null
  if (!t || !t.tagName) return false
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return true
  if (t.tagName === 'INPUT') return (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox'
  return false
}

export class GameInput {
  readonly keyboard = new KeyTracker()
  readonly gamepad = new GamepadSource()
  readonly haptics: Haptics
  readonly ui: UiEdges = makeUiEdges()
  keys: KeyBindings
  pad: PadBindings
  /** the pad is read at all (Settings → Controls) */
  gamepadEnabled = true
  /** the menus are up: the pedals read zero and the hotkeys do not fire */
  suppressGameplay = false
  /** frames to ignore after a rebind, so the key that finished it is not also played */
  swallowFrames = 0
  private menuRepeat = 0
  private lastMenuDir = 0
  /** pad buttons that went down this frame, by action — the hotkey dispatch reads these */
  private padEdges = new Set<Action>()
  /**
   * Keys that were already down when the menu opened. W is the throttle and also "menu up", so
   * pausing with the pedal floored had the cursor jump to the bottom of the menu before the
   * finger came off. A key held from before the menu is ignored by the menu until released.
   */
  private stale = new Set<string>()

  constructor(keys: KeyBindings, pad: PadBindings) {
    this.keys = keys
    this.pad = pad
    this.haptics = new Haptics(this.gamepad)
  }

  attach(target: Window): void {
    this.keyboard.attach(target)
    this.gamepad.attach(target)
  }

  detach(target: Window): void {
    this.keyboard.detach(target)
    this.gamepad.detach(target)
  }

  /** the menu just opened: whatever is held now is not a menu key until it is let go */
  menuOpened(): void {
    this.stale = new Set(this.keyboard.down)
  }

  /** the action a key code is bound to, if any — what the keydown switch asks */
  actionOf(code: string, opts: { driving?: boolean } = {}): Action | null {
    const hits: Action[] = []
    for (const [a, codes] of Object.entries(this.keys)) if (codes.includes(code)) hits.push(a as Action)
    if (hits.length === 0) return null
    if (hits.length === 1) return hits[0]
    // a key bound to both fire and interface: fire from the seat, hide the chrome from the air
    if (hits.includes('fire') && hits.includes('interface')) return opts.driving ? 'fire' : 'interface'
    return hits[0]
  }

  private keyDown(a: Action): boolean {
    for (const c of this.keys[a] ?? []) if (this.keyboard.isDown(c)) return true
    return false
  }
  private keyPressed(a: Action): boolean {
    for (const c of this.keys[a] ?? []) if (this.keyboard.wasPressed(c)) return true
    return false
  }
  private padValue(a: Action): number {
    if (!this.gamepadEnabled) return 0
    let v = 0
    for (const b of this.pad[a] ?? []) v = Math.max(v, this.gamepad.value(b))
    return v
  }
  private padPressed(a: Action): boolean {
    if (!this.gamepadEnabled) return false
    for (const b of this.pad[a] ?? []) if (this.gamepad.pressed(b)) return true
    return false
  }

  /** Once a frame, before anything reads. `dt` drives the menu auto-repeat. */
  poll(dt: number): void {
    const gp = this.gamepad
    this.keyboard.beginFrame()
    if (this.gamepadEnabled) gp.poll()
    const ui = this.ui
    const padOn = this.gamepadEnabled && gp.connected

    this.padEdges.clear()
    if (padOn) for (const a of Object.keys(this.pad) as Action[]) if (this.padPressed(a)) this.padEdges.add(a)

    // Escape is the keyboard's pause and it arrives by DOM event (main.ts), where the shell's own
    // Escape — close the dialog, close the drawer — has already had its capture-phase say. Only
    // the pad's pause comes through here.
    ui.pause = this.padEdges.has('pause')
    ui.confirm = this.keyPressed('confirm') || this.keyboard.wasPressed('Space') || (padOn && this.padEdges.has('confirm'))
    ui.back = this.keyboard.wasPressed('Backspace') || (padOn && gp.pressed('b1'))
    ui.any = this.keyboard.anyEdge || gp.lastPressed !== ''

    /*
     * A TAP IS A STEP; A HOLD IS PACED. Each distinct press moves the cursor once, at once, whatever
     * the repeat timer says — and only a key that stays down is paced (0.35 s, then every 0.12 s).
     * Measured the other way round at 1.5 frames a second under software GL: taps landed as edges
     * but the repeat window ate all but one in four, and a cursor that moves once per two seconds
     * of pressing is a menu that does not work on a slow machine.
     */
    const kb = this.keyboard
    for (const c of this.stale) if (!kb.isDown(c)) this.stale.delete(c)
    const tap = (code: string, pad: string) => kb.wasPressed(code) || (padOn && gp.pressed(pad))
    const held = (code: string, pad: string, axis: string) => (kb.isDown(code) && !this.stale.has(code)) || (padOn && (gp.value(axis) > 0.5 || gp.down(pad)))
    const tapY = (tap('ArrowDown', 'b13') || tap('KeyS', 'b13') ? 1 : 0) - (tap('ArrowUp', 'b12') || tap('KeyW', 'b12') ? 1 : 0)
    const tapX = (tap('ArrowRight', 'b15') || tap('KeyD', 'b15') ? 1 : 0) - (tap('ArrowLeft', 'b14') || tap('KeyA', 'b14') ? 1 : 0)
    const holdY = (held('ArrowDown', 'b13', 'a1+') || held('KeyS', 'b13', 'a1+') ? 1 : 0) - (held('ArrowUp', 'b12', 'a1-') || held('KeyW', 'b12', 'a1-') ? 1 : 0)
    const holdX = (held('ArrowRight', 'b15', 'a0+') || held('KeyD', 'b15', 'a0+') ? 1 : 0) - (held('ArrowLeft', 'b14', 'a0-') || held('KeyA', 'b14', 'a0-') ? 1 : 0)
    ui.menuUp = ui.menuDown = ui.menuLeft = ui.menuRight = false
    const tapDir = tapY * 2 + tapX
    const holdDir = holdY * 2 + holdX
    if (tapDir !== 0) {
      ui.menuDown = tapY > 0
      ui.menuUp = tapY < 0
      ui.menuRight = tapX > 0
      ui.menuLeft = tapX < 0
      this.menuRepeat = 0.35
      this.lastMenuDir = holdDir
    } else if (holdDir !== 0) {
      if (holdDir !== this.lastMenuDir) this.menuRepeat = 0
      if (this.menuRepeat <= 0) {
        ui.menuDown = holdY > 0
        ui.menuUp = holdY < 0
        ui.menuRight = holdX > 0
        ui.menuLeft = holdX < 0
        this.menuRepeat = 0.12
      }
      this.menuRepeat -= dt
      this.lastMenuDir = holdDir
    } else {
      this.menuRepeat = 0
      this.lastMenuDir = 0
    }

    if (this.swallowFrames > 0) {
      this.swallowFrames--
      ui.pause = ui.confirm = ui.back = ui.any = false
      ui.menuUp = ui.menuDown = ui.menuLeft = ui.menuRight = false
      this.padEdges.clear()
    }
    this.keyboard.endFrame()
  }

  /** the action is held right now, key or pad — the machine gun's trigger */
  held(a: Action): boolean {
    return !this.suppressGameplay && (this.keyDown(a) || this.padValue(a) > 0.5)
  }

  /** a pad button bound to this action went down this frame (keyboard hotkeys arrive by event) */
  padHotkey(a: Action): boolean {
    return !this.suppressGameplay && this.padEdges.has(a)
  }

  /** the pedals this frame: keys or pad, whichever is further */
  drive(): DriveRead {
    if (this.suppressGameplay) return { steer: 0, throttle: 0, brake: 0, handbrake: false }
    let steer = 0
    if (this.keyDown('steerLeft')) steer -= 1
    if (this.keyDown('steerRight')) steer += 1
    steer += this.padValue('steerRight') - this.padValue('steerLeft')
    return {
      steer: Math.max(-1, Math.min(1, steer)),
      throttle: Math.max(this.keyDown('throttle') ? 1 : 0, this.padValue('throttle')),
      brake: Math.max(this.keyDown('brake') ? 1 : 0, this.padValue('brake')),
      handbrake: this.keyDown('handbrake') || this.padValue('handbrake') > 0.5,
    }
  }

  /**
   * The pad in the air: left stick moves, right stick looks, the triggers climb and descend. The
   * keyboard's share of this is fly.ts's own, unchanged.
   */
  fly(): FlyRead {
    const gp = this.gamepad
    if (this.suppressGameplay || !this.gamepadEnabled || !gp.connected) return { fwd: 0, side: 0, up: 0, lookYaw: 0, lookPitch: 0 }
    return {
      fwd: gp.value('a1-') - gp.value('a1+'),
      side: gp.value('a0+') - gp.value('a0-'),
      up: gp.value('b7') - gp.value('b6'),
      lookYaw: gp.value('a2+') - gp.value('a2-'),
      lookPitch: gp.value('a3+') - gp.value('a3-'),
    }
  }

  /**
   * The right stick in the car: a look round it. Not a binding — the right stick is the look on
   * every pad ever made, and a rebinding row for it would only be a way to break it. Dead-zoned by
   * the engine's axis shaping; `active` is what the camera springs back on.
   */
  look(): LookRead {
    const gp = this.gamepad
    if (this.suppressGameplay || !this.gamepadEnabled || !gp.connected) return { x: 0, y: 0, active: false }
    const x = gp.value('a2+') - gp.value('a2-')
    const y = gp.value('a3-') - gp.value('a3+')
    return { x, y, active: Math.abs(x) > 0.02 || Math.abs(y) > 0.02 }
  }

  get padConnected(): boolean {
    return this.gamepadEnabled && this.gamepad.connected
  }
}
