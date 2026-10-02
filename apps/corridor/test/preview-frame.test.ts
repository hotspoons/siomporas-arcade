// The preview's clip and its GL viewport, in the right frame.
//
// Rich, 2026-09-29: *"the dark mask and blur is over top of the preview and the main editor … half
// the screen is covered"*. The preview computed both rectangles in WINDOW coordinates, which is
// identical to canvas coordinates exactly when the canvas fills the window — which it does on the
// standalone editor page and does NOT in the world editor, where it is a pane with a bar above and
// an inspector beside it.
//
// So the test that matters is the one that uses a canvas which is NOT the window. A test written
// against a full-window canvas passes on the broken version, which is presumably why there wasn't
// one.
import { describe, expect, it } from 'vitest'
import { insetOf, viewportOf, type Rect } from '../src/editor/view/preview'

const rect = (left: number, top: number, width: number, height: number): Rect =>
  ({ left, top, width, height, right: left + width, bottom: top + height })

describe('the preview draws into the right rectangle', () => {
  /*
   * THE CASE THAT ALWAYS WORKED. Kept because it is the one that hid the bug: any formula that gets
   * this right and the next one wrong looks correct on the standalone editor page.
   */
  it('a canvas that fills the window', () => {
    const canvas = rect(0, 0, 1280, 800)
    const view = rect(400, 60, 700, 600)
    expect(insetOf(canvas, view)).toBe('inset(60px 180px 140px 400px)')
    expect(viewportOf(canvas, view)).toEqual({ x: 400, y: 140, w: 700, h: 600 })
  })

  it('a canvas that is a PANE — the embedded editor', () => {
    // a 1100 x 760 window, with a 180px rail, a 64px bar and a 240px inspector
    const canvas = rect(180, 64, 680, 632)
    // the preview's viewport, somewhere inside that pane
    const view = rect(240, 120, 500, 480)

    // measured from the CANVAS's own border box, never from the window
    expect(insetOf(canvas, view)).toBe('inset(56px 120px 96px 60px)')
    expect(viewportOf(canvas, view)).toEqual({ x: 60, y: 96, w: 500, h: 480 })
  })

  /*
   * AND THE TWO AGREE. The inset and the viewport are computed separately and describe the same
   * rectangle from opposite corners; if they ever disagree the picture is drawn in one place and
   * revealed in another, which is precisely what "half the screen is covered" looks like.
   */
  it('the hole the clip opens is the rectangle the viewport fills', () => {
    const canvas = rect(180, 64, 680, 632)
    for (const view of [rect(240, 120, 500, 480), rect(180, 64, 680, 632), rect(300, 300, 100, 100)]) {
      const m = /inset\((-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px\)/.exec(insetOf(canvas, view))!
      const [top, right, bottom, left] = m.slice(1).map(Number)
      const vp = viewportOf(canvas, view)
      // the clip's hole, in canvas coordinates, counting down from the top
      expect(left).toBeCloseTo(vp.x, 9)
      expect(canvas.height - top - bottom).toBeCloseTo(vp.h, 9)
      expect(canvas.width - left - right).toBeCloseTo(vp.w, 9)
      /*
       * GL counts UP from the bottom, `inset` counts DOWN from the top, so the two describe the
       * same band from opposite ends: the bottom inset IS the viewport's y, and the viewport's top
       * edge sits `height − topInset` above the canvas bottom.
       */
      expect(bottom).toBeCloseTo(vp.y, 9)
      expect(canvas.height - top).toBeCloseTo(vp.y + vp.h, 9)
    }
  })

  it('a viewport filling the pane has no inset at all', () => {
    const canvas = rect(180, 64, 680, 632)
    expect(insetOf(canvas, canvas)).toBe('inset(0px 0px 0px 0px)')
    expect(viewportOf(canvas, canvas)).toEqual({ x: 0, y: 0, w: 680, h: 632 })
  })

  /*
   * THE OLD FORMULA, WRITTEN OUT, so the failure it caused is recorded rather than described. On a
   * pane it puts the viewport 180 px to the right and 64 px too low — the offset Rich saw.
   */
  it('the window-relative formula is wrong on a pane, by exactly the pane offset', () => {
    const win = { w: 1100, h: 760 }
    const canvas = rect(180, 64, 680, 632)
    const view = rect(240, 120, 500, 480)
    const oldViewport = { x: view.left, y: win.h - view.bottom, w: view.width, h: view.height }
    const now = viewportOf(canvas, view)
    expect(oldViewport.x - now.x).toBe(canvas.left)
    expect(oldViewport.y - now.y).toBe(win.h - canvas.bottom)
  })
})
