// A pad read through its layout: the macOS HID reading of an Xbox-shaped pad (triggers on axes,
// the D-pad on a hat), and presses as edges — so a resting trigger never counts as a press.
import { afterEach, describe, expect, it } from 'vitest'
import { GamepadSource, hatDirection, layoutFor } from '../src/input/GamepadSource'

function pad(o: { mapping?: string; buttons?: number; axes?: number[]; down?: number[] }) {
  const n = o.buttons ?? 17
  const down = new Set(o.down ?? [])
  return {
    id: '8BitDo Ultimate 2C Wireless Controller (Vendor: 2dc8 Product: 301c)', index: 0, connected: true, timestamp: 0,
    mapping: o.mapping ?? 'standard',
    buttons: Array.from({ length: n }, (_, i) => ({ pressed: down.has(i), value: down.has(i) ? 1 : 0, touched: false })),
    axes: o.axes ?? [0, 0, 0, 0],
  }
}
const nav = globalThis.navigator as { getGamepads?: () => unknown[] }
const had = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(nav) ?? nav, 'getGamepads')
const padsAre = (p: unknown[]) => Object.defineProperty(nav, 'getGamepads', { value: () => p, configurable: true, writable: true })
afterEach(() => { if (!had) delete (nav as { getGamepads?: unknown }).getGamepads })

/** the 8BitDo at rest, as hardwaretester.com showed it: triggers at −1, the hat at 3.29 */
const REST = [0, 0, 0, -1, -1, 0, 0, 0, 0, 3.28571]

describe('the macOS HID layout', () => {
  it('is picked for a non-standard pad with 15 buttons and 10 axes, and identity for a standard one', () => {
    expect(layoutFor(pad({ mapping: '', buttons: 15, axes: REST })).hat).toBe(9)
    expect(layoutFor(pad({})).hat).toBe(-1)
  })

  it('reads the triggers from axes 3 and 4 into RT and LT, with nothing pressed at rest', () => {
    const g = new GamepadSource()
    padsAre([pad({ mapping: '', buttons: 15, axes: REST })])
    g.poll()
    expect(g.value('b7')).toBe(0)
    expect(g.value('b6')).toBe(0)
    expect(g.lastPressed).toBe('')
    const pulled = [...REST]; pulled[3] = 0.6; pulled[4] = -0.2
    padsAre([pad({ mapping: '', buttons: 15, axes: pulled })])
    g.poll()
    expect(g.value('b7')).toBeCloseTo(0.8)
    expect(g.value('b6')).toBeCloseTo(0.4)
    expect(g.down('b7')).toBe(true)
  })

  it('reads the hat on axis 9 as the four D-pad buttons, and View / Start / X / Y from where the Mac puts them', () => {
    const g = new GamepadSource()
    const east = [...REST]; east[9] = -3 / 7
    padsAre([pad({ mapping: '', buttons: 15, axes: east, down: [10, 11, 3, 4, 6, 7] })])
    g.poll()
    expect(g.down('b15')).toBe(true) // right
    expect(g.down('b12')).toBe(false)
    expect(g.down('b8')).toBe(true) // View
    expect(g.down('b9')).toBe(true) // Start
    expect(g.down('b2') && g.down('b3')).toBe(true) // X, Y
    expect(g.down('b4') && g.down('b5')).toBe(true) // LB, RB
    expect(hatDirection(3.28571)).toBe(-1)
    expect(hatDirection(-1)).toBe(0)
    expect(hatDirection(1 / 7)).toBe(4)
    // the right stick is axes 2 and 5 here
    const stick = [...REST]; stick[5] = 0.9
    padsAre([pad({ mapping: '', buttons: 15, axes: stick })])
    g.poll()
    expect(g.value('a3+')).toBeGreaterThan(0.5)
  })
})

describe('a stick must be swept before it is trusted', () => {
  it('reads zero on a pad that has just connected, even when an axis rests off centre', () => {
    const g = new GamepadSource()
    // a pad read through the wrong layout can rest a stick at a large value; it must not apply
    padsAre([pad({ axes: [0.9, 0, 0, 0] })])
    g.poll()
    expect(g.value('a0+')).toBe(0)
    expect(g.value('a0-')).toBe(0)
  })

  it('reads a swept axis, and zero when it homes again', () => {
    const g = new GamepadSource()
    padsAre([pad({ axes: [0, 0, 0, 0] })])
    g.poll()
    padsAre([pad({ axes: [0.8, 0, 0, 0] })])
    g.poll()
    expect(g.value('a0+')).toBeGreaterThan(0.5)
    padsAre([pad({ axes: [0, 0, 0, 0] })])
    g.poll()
    expect(g.value('a0+')).toBe(0)
    expect(g.value('a0-')).toBe(0)
  })

  it('calibrates the halves apart: sweeping one way and homing does not read the other', () => {
    const g = new GamepadSource()
    padsAre([pad({ axes: [0, 0, 0, 0] })])
    g.poll()
    // only the positive half is ever swept
    padsAre([pad({ axes: [0.6, 0, 0, 0] })])
    g.poll()
    expect(g.value('a0+')).toBeGreaterThan(0)
    padsAre([pad({ axes: [0, 0, 0, 0] })])
    g.poll()
    expect(g.value('a0-')).toBe(0)
  })

  it('re-learns on a different pad rather than inheriting the span', () => {
    const g = new GamepadSource()
    padsAre([pad({ axes: [0, 0, 0, 0] })])
    g.poll()
    padsAre([pad({ axes: [0.8, 0, 0, 0] })])
    g.poll()
    expect(g.value('a0+')).toBeGreaterThan(0.5)
    // a different pad (a different index) starts over: its resting 0.9 is not trusted
    padsAre([{ ...pad({ axes: [0.9, 0, 0, 0] }), index: 1 }])
    g.poll()
    expect(g.value('a0+')).toBe(0)
  })
})

describe('presses are edges', () => {
  it('reports an axis push once, not every frame it is held, so a rebind waits for a fresh push', () => {
    const g = new GamepadSource()
    const seen: string[] = []
    g.onAny = (b) => seen.push(b)
    padsAre([pad({ axes: [0.9, 0, 0, 0] })])
    g.poll(); g.poll(); g.poll()
    expect(seen).toEqual(['a0+'])
    padsAre([pad({ axes: [0, 0, 0, 0] })])
    g.poll()
    padsAre([pad({ axes: [0.9, 0, 0, 0] })])
    g.poll()
    expect(seen).toEqual(['a0+', 'a0+'])
  })

  it('a button held from before is not a press until it is let go and pressed again', () => {
    const g = new GamepadSource()
    const seen: string[] = []
    padsAre([pad({ down: [0] })])
    g.poll()
    g.onAny = (b) => seen.push(b)
    g.poll(); g.poll()
    expect(seen).toEqual([])
    padsAre([pad({})]); g.poll()
    padsAre([pad({ down: [0] })]); g.poll()
    expect(seen).toEqual(['b0'])
  })
})
