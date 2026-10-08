// Keys and pad → pedals, hotkeys and menu edges, played without a browser: the key tracker is
// pressed directly and the gamepad is a stub of `navigator.getGamepads`.
import { afterEach, describe, expect, it } from 'vitest'
import { GameInput, KeyTracker, typing } from '../src/game/move/gameinput'
import { DEFAULT_KEYS, DEFAULT_PAD, DEFAULT_SETTINGS, engineGain, sfxGain } from '../src/game/session/gamesettings'

/** a standard-mapping pad with one button and one axis set */
function fakePad(buttons: Record<number, number> = {}, axes: Record<number, number> = {}) {
  const b = Array.from({ length: 17 }, (_, i) => ({ pressed: (buttons[i] ?? 0) > 0.5, value: buttons[i] ?? 0, touched: false }))
  const a = Array.from({ length: 4 }, (_, i) => axes[i] ?? 0)
  return { id: 'Xbox Wireless Controller (045e)', index: 0, connected: true, mapping: 'standard', timestamp: 0, buttons: b, axes: a }
}

const nav = globalThis.navigator as { getGamepads?: () => unknown[] }
const hadGetGamepads = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nav) ?? nav, 'getGamepads')
function padsAre(pads: unknown[]) {
  Object.defineProperty(nav, 'getGamepads', { value: () => pads, configurable: true, writable: true })
}
afterEach(() => {
  if (!hadGetGamepads) delete (nav as { getGamepads?: unknown }).getGamepads
})

describe('KeyTracker', () => {
  it('records a press as an edge for exactly one poll and as held until released', () => {
    const k = new KeyTracker()
    k.press('KeyW')
    k.beginFrame()
    expect(k.wasPressed('KeyW')).toBe(true)
    expect(k.isDown('KeyW')).toBe(true)
    k.endFrame()
    // the edge survives to the end of the frame it was polled in (reads after poll)…
    expect(k.wasPressed('KeyW')).toBe(true)
    k.beginFrame()
    // …and is gone the frame after
    expect(k.wasPressed('KeyW')).toBe(false)
    expect(k.isDown('KeyW')).toBe(true)
    k.release('KeyW')
    expect(k.isDown('KeyW')).toBe(false)
  })

  it('tells a rebind capture about every press through onAny', () => {
    const k = new KeyTracker()
    const seen: string[] = []
    k.onAny = (c) => seen.push(c)
    k.press('KeyQ')
    k.press('KeyQ') // held: not a second press
    k.release('KeyQ')
    k.press('KeyQ')
    expect(seen).toEqual(['KeyQ', 'KeyQ'])
  })
})

describe('typing()', () => {
  it('keeps the game’s hands off text fields but not off sliders and switches', () => {
    const field = (tagName: string, type = '') => ({ tagName, type, isContentEditable: false }) as unknown as EventTarget
    expect(typing(field('INPUT', 'text'))).toBe(true)
    expect(typing(field('INPUT', 'search'))).toBe(true)
    expect(typing(field('TEXTAREA'))).toBe(true)
    expect(typing(field('SELECT'))).toBe(true)
    expect(typing(field('INPUT', 'range'))).toBe(false)
    expect(typing(field('INPUT', 'checkbox'))).toBe(false)
    expect(typing(field('DIV'))).toBe(false)
    expect(typing(null)).toBe(false)
  })
})

describe('GameInput', () => {
  it('reads the default keys as pedals', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    padsAre([])
    inp.keyboard.press('KeyW')
    inp.keyboard.press('ArrowLeft')
    inp.keyboard.press('ShiftLeft')
    inp.poll(1 / 60)
    expect(inp.drive()).toEqual({ steer: -1, throttle: 1, brake: 0, handbrake: true })
  })

  it('reads the pad’s triggers as analog pedals and the stick as steering', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    // the stick is swept from rest before it is trusted (GamepadSource.calibrate)
    padsAre([fakePad({}, { 0: 0 })])
    inp.poll(1 / 60)
    padsAre([fakePad({ 7: 0.6, 6: 0.25 }, { 0: 0.9 })])
    inp.poll(1 / 60)
    const d = inp.drive()
    expect(d.throttle).toBeCloseTo(0.6, 5)
    expect(d.brake).toBeCloseTo(0.25, 5)
    expect(d.steer).toBeGreaterThan(0.6) // shaped: deadzone and curve, but most of the way
    expect(d.handbrake).toBe(false)
    expect(inp.padConnected).toBe(true)
  })

  it('maps a key code to its action, and Ctrl to fire from the seat', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    expect(inp.actionOf('Tab')).toBe('drive')
    expect(inp.actionOf('KeyR')).toBe('recover')
    expect(inp.actionOf('ControlLeft', { driving: true })).toBe('fire')
    expect(inp.actionOf('Space', { driving: true })).toBe('gun')
    expect(inp.actionOf('KeyM', { driving: true })).toBe('interface')
    expect(inp.actionOf('KeyM', { driving: false })).toBe('interface')
    expect(inp.actionOf('KeyZ')).toBeNull()
    // a rebind is a change to the table, nothing else
    inp.keys.recover = ['KeyZ']
    expect(inp.actionOf('KeyZ')).toBe('recover')
    expect(inp.actionOf('KeyR')).toBeNull()
  })

  it('turns Start into pause and a pad button into a hotkey edge, once per press', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    padsAre([fakePad({ 9: 1, 3: 1 })]) // Start, and Y = recover
    inp.poll(1 / 60)
    expect(inp.ui.pause).toBe(true)
    expect(inp.padHotkey('recover')).toBe(true)
    // still held next frame: no new edge
    inp.poll(1 / 60)
    expect(inp.ui.pause).toBe(false)
    expect(inp.padHotkey('recover')).toBe(false)
  })

  it('gives the menu nothing to drive with once the pad is switched off', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    inp.gamepadEnabled = false
    padsAre([fakePad({ 9: 1, 7: 1 })])
    inp.poll(1 / 60)
    expect(inp.ui.pause).toBe(false)
    expect(inp.drive().throttle).toBe(0)
    expect(inp.padConnected).toBe(false)
  })

  it('hands the world nothing while the menu is up', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    padsAre([fakePad({ 7: 1, 3: 1 }, { 1: -1 })])
    inp.keyboard.press('KeyW')
    inp.suppressGameplay = true
    inp.poll(1 / 60)
    expect(inp.drive()).toEqual({ steer: 0, throttle: 0, brake: 0, handbrake: false })
    expect(inp.fly().fwd).toBe(0)
    expect(inp.padHotkey('camera')).toBe(false)
    // but the menu's own edges still arrive: the stick moves the cursor
    expect(inp.ui.menuUp).toBe(true)
  })

  it('counts every distinct tap as a step, however slow the frames (the repeat window paces holds only)', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    padsAre([])
    let steps = 0
    // 1.5 frames a second (dt capped at 0.1 by the loop), a tap between every two frames
    for (let i = 0; i < 8; i++) {
      inp.keyboard.press('ArrowDown')
      inp.keyboard.release('ArrowDown')
      inp.poll(0.1)
      if (inp.ui.menuDown) steps++
    }
    expect(steps).toBe(8)
    // a tap that lands in the same frame as the start of a hold is one step, not two
    inp.keyboard.press('ArrowDown')
    inp.poll(0.1)
    expect(inp.ui.menuDown).toBe(true)
    inp.poll(0.1)
    expect(inp.ui.menuDown).toBe(false) // held: paced
  })

  it('ignores a key held from before the menu opened until it is released (W is the throttle AND menu up)', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    padsAre([])
    inp.keyboard.press('KeyW')
    inp.poll(0.1)
    inp.menuOpened()
    for (let i = 0; i < 10; i++) { inp.poll(0.1); expect(inp.ui.menuUp).toBe(false) }
    inp.keyboard.release('KeyW')
    inp.keyboard.press('KeyW')
    inp.poll(0.1)
    expect(inp.ui.menuUp).toBe(true)
  })

  it('auto-repeats the menu direction: at once, then after a wait, then quickly', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    padsAre([])
    inp.keyboard.press('ArrowDown')
    const downs: boolean[] = []
    for (let i = 0; i < 60; i++) { inp.poll(1 / 60); downs.push(inp.ui.menuDown) }
    const firings = downs.map((d, i) => (d ? i : -1)).filter((i) => i >= 0)
    expect(firings[0]).toBe(0)
    expect(firings[1]).toBeGreaterThanOrEqual(20) // ~0.35 s at 60 Hz
    expect(firings[2] - firings[1]).toBeLessThanOrEqual(9) // then ~0.12 s
  })

  it('never moves the menu with a pad direction that was held when it opened, until it comes home', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    // the stick swept so it is trusted, then held down while the menu opens; the D-pad held down too
    for (const y of [0, 1, -1, 0]) { padsAre([fakePad({}, { 1: y })]); inp.poll(1 / 60) }
    padsAre([fakePad({ 13: 1 }, { 1: 1 })])
    inp.poll(1 / 60)
    inp.menuOpened()
    for (let i = 0; i < 120; i++) { inp.poll(1 / 60); expect(inp.ui.menuDown).toBe(false) }
    // let go of both, push the stick again: that is on purpose, and it moves at once
    padsAre([fakePad({}, { 1: 0 })])
    inp.poll(1 / 60)
    expect(inp.ui.menuDown).toBe(false)
    padsAre([fakePad({}, { 1: 1 })])
    inp.poll(1 / 60)
    expect(inp.ui.menuDown).toBe(true)
  })

  it('never moves the menu with a D-pad that has never been seen at rest', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    // down "held" from the first poll — the uninitialised-hat case, whatever the layout made of it
    padsAre([fakePad({ 13: 1 })])
    for (let i = 0; i < 120; i++) { inp.poll(1 / 60); expect(inp.ui.menuDown).toBe(false) }
  })

  it('swallows the frames after a rebind so the key that finished it is not also played', () => {
    const inp = new GameInput(structuredClone(DEFAULT_KEYS), structuredClone(DEFAULT_PAD))
    padsAre([fakePad({ 9: 1 })])
    inp.swallowFrames = 1
    inp.poll(1 / 60)
    expect(inp.ui.pause).toBe(false)
    padsAre([fakePad({ 9: 0 })])
    inp.poll(1 / 60)
    padsAre([fakePad({ 9: 1 })])
    inp.poll(1 / 60)
    expect(inp.ui.pause).toBe(true)
  })
})

describe('the audio gains', () => {
  it('multiply master by the bus and go to nothing when muted', () => {
    expect(engineGain({ master: 0.5, engine: 0.5, sfx: 1, muted: false })).toBeCloseTo(0.25)
    expect(sfxGain({ master: 0.5, engine: 1, sfx: 0.2, muted: false })).toBeCloseTo(0.1)
    expect(engineGain({ master: 1, engine: 1, sfx: 1, muted: true })).toBe(0)
    expect(sfxGain({ master: 1, engine: 1, sfx: 1, muted: true })).toBe(0)
    // out-of-range and NaN are clamped rather than passed to a GainNode
    expect(engineGain({ master: 3, engine: NaN, sfx: 1, muted: false })).toBe(0)
    expect(engineGain({ master: 3, engine: 1, sfx: 1, muted: false })).toBe(1)
  })
  it('default every action to at least one binding, key or pad', () => {
    for (const a of Object.keys(DEFAULT_SETTINGS.keys)) {
      expect((DEFAULT_KEYS[a].length + (DEFAULT_PAD[a]?.length ?? 0)) > 0, a).toBe(true)
    }
  })
})

describe('the pad layout', () => {
  it('puts the pedals on the triggers, recover on Y, lights on X, the view on the left centre button, and leaves B free', () => {
    expect(DEFAULT_PAD.throttle).toEqual(['b7'])
    expect(DEFAULT_PAD.brake).toEqual(['b6'])
    expect(DEFAULT_PAD.handbrake).toEqual(['b0'])
    expect(DEFAULT_PAD.recover).toEqual(['b3'])
    expect(DEFAULT_PAD.lights).toEqual(['b2'])
    expect(DEFAULT_PAD.camera).toEqual(['b8'])
    expect(DEFAULT_PAD.pause).toEqual(['b9'])
    expect(DEFAULT_PAD.objPrev).toEqual(['b14'])
    expect(DEFAULT_PAD.objNext).toEqual(['b15'])
    // flight is a level's decision, not a button; B is the menus' back and nothing in play
    for (const a of ['drive', 'craft', 'walk'] as const) expect(DEFAULT_PAD[a]).toEqual([])
    const used = new Set(Object.values(DEFAULT_PAD).flat())
    expect(used.has('b1')).toBe(false)
    expect(DEFAULT_PAD.gun).toEqual(['b4'])
    expect(DEFAULT_PAD.fire).toEqual(['b5'])
  })

  it('reads the right stick as a look that is active only off centre, and not while the menu is up', () => {
    const input = new GameInput(DEFAULT_KEYS, DEFAULT_PAD)
    // the right stick is swept from rest before it is trusted (GamepadSource.calibrate)
    padsAre([fakePad({}, { 2: 0, 3: 0 })])
    input.poll(1 / 60)
    padsAre([fakePad({}, { 2: 0.8, 3: -0.5 })])
    input.poll(1 / 60)
    const l = input.look()
    expect(l.active).toBe(true)
    expect(l.x).toBeGreaterThan(0.5)
    expect(l.y).toBeGreaterThan(0.1) // stick up is + up (after the dead zone)
    padsAre([fakePad({}, { 2: 0, 3: 0 })])
    input.poll(1 / 60)
    expect(input.look()).toEqual({ x: 0, y: 0, active: false })
    padsAre([fakePad({}, { 2: 0.8 })])
    input.suppressGameplay = true
    input.poll(1 / 60)
    expect(input.look().active).toBe(false)
  })
})
