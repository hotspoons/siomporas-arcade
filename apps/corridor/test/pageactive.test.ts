// A page is backgrounded when it is hidden OR when frames have stopped arriving, whatever its
// visibilityState says — the reloaded-into-a-background-window case (Rich, 2026-10-10).

import { describe, expect, it } from 'vitest'
import { classify, STALL_MS } from '../src/world/pageactive'

describe('classify', () => {
  it('a visible, focused page painting frames is attended', () => {
    expect(classify({ hidden: false, focused: true, sinceFrameMs: 16 })).toMatchObject({ backgrounded: false, unfocused: false })
  })
  it('a hidden page is backgrounded', () => {
    expect(classify({ hidden: true, focused: false, sinceFrameMs: 0 }).backgrounded).toBe(true)
  })
  it('a "visible" page that has painted nothing for the stall time is backgrounded', () => {
    expect(classify({ hidden: false, focused: true, sinceFrameMs: STALL_MS + 1 }).backgrounded).toBe(true)
    // a long hitch is not
    expect(classify({ hidden: false, focused: true, sinceFrameMs: 400 }).backgrounded).toBe(false)
  })
  it('painting but without the keyboard is unfocused, not backgrounded', () => {
    expect(classify({ hidden: false, focused: false, sinceFrameMs: 16 })).toMatchObject({ backgrounded: false, unfocused: true })
    // backgrounded wins; unfocused is only said of a painted page
    expect(classify({ hidden: true, focused: false, sinceFrameMs: 16 })).toMatchObject({ backgrounded: true, unfocused: false })
  })
})
