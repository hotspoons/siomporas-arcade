// A docked inspector you can drag wider, and that remembers how wide you left it.
//
// Rich, 2026-09-27: "The side bar for the world editor needs to be resizable and not scroll
// horizontally."
//
// Two separate faults with one cause. The panel was a fixed `min(340px, 92vw)` and its contents
// were not told they may shrink, so a long road name or a wide row pushed the panel's own content
// box out and the text ran off under the edge. In CSS grid and flex a child's automatic minimum
// size is its CONTENT size, not zero -- which is why a single unbreakable string makes a whole
// column refuse to narrow. The width is now a variable you can drag, and `min-width: 0` plus a
// wrapping rule (world.css) lets the contents obey it.
//
// The width lives in a custom property on :root, so the map -- which sizes itself as
// `100vw - var(--inspector-w)` -- follows the drag with no second source of truth and no resize
// event to miss.

const KEY = 'corridor.inspector.w'
const MIN = 260
/** never more than this share of the window, so the map cannot be dragged away entirely */
const MAX_SHARE = 0.8

/** the width to open at: what this browser was left at, clamped to what fits today */
function stored(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY))
    return Number.isFinite(v) && v >= MIN ? v : null
  } catch {
    return null // private window, blocked storage: the default width is a fine answer
  }
}

function clamp(w: number): number {
  return Math.max(MIN, Math.min(w, Math.round(window.innerWidth * MAX_SHARE)))
}

/**
 * Make `aside` draggable by its left edge. Returns a function that removes the grip.
 *
 * The grip is a real element rather than CSS `resize`, because `resize` only grows an element
 * down-and-right and a right-docked panel has to grow LEFT.
 */
export function dockWidth(aside: HTMLElement): () => void {
  const apply = (w: number) => document.documentElement.style.setProperty('--inspector-w', `${clamp(w)}px`)
  const start = stored()
  if (start !== null) apply(start)

  const grip = document.createElement('div')
  grip.className = 'dock-grip'
  grip.title = 'drag to resize'
  // it is a control, so it says so: a keyboard can widen and narrow it too
  grip.setAttribute('role', 'separator')
  grip.setAttribute('aria-orientation', 'vertical')
  grip.tabIndex = 0
  aside.prepend(grip)

  let from = 0
  let w0 = 0
  const move = (e: PointerEvent) => {
    // dragging LEFT makes it wider: the panel is docked to the right edge
    apply(w0 + (from - e.clientX))
  }
  const up = (e: PointerEvent) => {
    grip.releasePointerCapture?.(e.pointerId)
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.classList.remove('dock-dragging')
    try {
      localStorage.setItem(KEY, String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--inspector-w'), 10)))
    } catch {
      /* nothing to do: the drag still applies to this session */
    }
  }
  const down = (e: PointerEvent) => {
    e.preventDefault()
    from = e.clientX
    w0 = aside.getBoundingClientRect().width
    grip.setPointerCapture?.(e.pointerId)
    document.body.classList.add('dock-dragging')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  grip.addEventListener('pointerdown', down)
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 64 : 16
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    apply(aside.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? step : -step))
    try {
      localStorage.setItem(KEY, String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--inspector-w'), 10)))
    } catch {
      /* as above */
    }
  }
  grip.addEventListener('keydown', key)
  // a window that has shrunk must not leave the panel wider than the window
  const onResize = () => {
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--inspector-w'), 10)
    if (Number.isFinite(cur)) apply(cur)
  }
  window.addEventListener('resize', onResize)

  return () => {
    grip.remove()
    window.removeEventListener('resize', onResize)
  }
}
