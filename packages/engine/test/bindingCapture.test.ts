import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BindingCapture, applyBinding, holdMeter } from '../src/app/BindingCapture'

class FakeKeys {
  readonly down = new Set<string>()
  onAny: ((code: string) => void) | null = null
  isDown(code: string): boolean {
    return this.down.has(code)
  }
  press(code: string): void {
    this.down.add(code)
    this.onAny?.(code)
  }
  release(code: string): void {
    this.down.delete(code)
  }
}
class FakePad {
  onAny: ((b: string) => void) | null = null
}

describe('BindingCapture', () => {
  let kb: FakeKeys
  let pad: FakePad
  let bound: [string, string][]
  let cancelled: number

  const capture = (allowEscape: boolean) => {
    bound = []
    cancelled = 0
    return new BindingCapture(kb, pad, {
      allowEscape,
      onKey: (code, mode) => bound.push([code, mode]),
      onPad: () => {},
      onCancel: () => cancelled++,
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    kb = new FakeKeys()
    pad = new FakePad()
  })

  it('sets the key on a tap', () => {
    capture(false)
    kb.press('KeyP')
    kb.release('KeyP')
    vi.advanceTimersByTime(100)
    expect(bound).toEqual([['KeyP', 'set']])
  })

  it('adds the key when it is held', () => {
    capture(false)
    kb.press('KeyP')
    vi.advanceTimersByTime(1000)
    expect(bound).toEqual([['KeyP', 'add']])
  })

  it('cancels on Escape where Escape cannot be bound', () => {
    capture(false)
    kb.press('Escape')
    expect(cancelled).toBe(1)
    expect(bound).toEqual([])
  })

  it('binds Escape when it is held on an action that allows it', () => {
    capture(true)
    kb.press('Escape')
    vi.advanceTimersByTime(1000)
    expect(bound).toEqual([['Escape', 'add']])
    expect(cancelled).toBe(0)
  })

  it('still cancels when Escape is only tapped', () => {
    capture(true)
    kb.press('Escape')
    kb.release('Escape')
    vi.advanceTimersByTime(100)
    expect(bound).toEqual([])
    expect(cancelled).toBe(1)
  })

  it('stops listening once it is done', () => {
    capture(false)
    kb.press('KeyP')
    vi.advanceTimersByTime(1000)
    expect(kb.onAny).toBeNull()
    kb.press('KeyJ')
    expect(bound).toEqual([['KeyP', 'add']])
  })
})

describe('applyBinding', () => {
  it('replaces on set and appends on add', () => {
    expect(applyBinding(['Escape'], 'KeyP', 'set')).toEqual(['KeyP'])
    expect(applyBinding(['KeyP'], 'Escape', 'add')).toEqual(['KeyP', 'Escape'])
    expect(applyBinding(['KeyP'], 'KeyP', 'add')).toEqual(['KeyP'])
    expect(applyBinding(undefined, 'KeyP', 'add')).toEqual(['KeyP'])
  })
})

describe('holdMeter', () => {
  it('grows with the hold and is empty before it starts', () => {
    expect(holdMeter(0)).toBe('')
    expect(holdMeter(0.5)).toBe('[====----]')
    expect(holdMeter(1)).toBe('[========]')
  })
})
