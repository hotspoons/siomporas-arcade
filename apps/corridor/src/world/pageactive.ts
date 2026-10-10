// Is anybody looking at this page — asked on a timer, not only on events.
//
// Rich, 2026-10-10: "when the tab reloads it doesn't detect if it is backgrounded. We need
// occasional checking (like once every couple of seconds check to see if it is backgrounded)".
//
// The app decided on `document.hidden` at the moment it asked, and on events. Neither is enough:
//   - a page RELOADED into a background tab, an occluded window, another virtual desktop or a
//     minimised one can report `visibilityState === 'visible'` while the browser has stopped
//     painting it — requestAnimationFrame simply does not fire. The builders then yield on a frame
//     that is not coming (budget.ts falls back to a 100 ms timer, clamped to ~1 s in a background
//     tab), so a load crawls; and nothing fires an event to say so, because nothing changed;
//   - focus moving to another application raises `blur` on some platforms and not on others.
//
// So the truth is three signals, re-read every couple of seconds and on every event that might
// move them: the document's own visibility, `document.hasFocus()`, and a FRAME HEARTBEAT — if no
// animation frame has arrived for `STALL_MS`, the page is backgrounded whatever `visibilityState`
// says. Subscribers hear only transitions.

/** a page that has painted no frame for this long is backgrounded (a 4 fps hitch is not) */
export const STALL_MS = 1500
/** how often the state is re-read when nothing has said it moved */
export const POLL_MS = 2000

export interface PageState {
  /** the browser paints nothing here: hidden, or no frame for STALL_MS */
  backgrounded: boolean
  /** painted but another window or application has the keyboard */
  unfocused: boolean
  /** `document.visibilityState === 'hidden'` — one of the reasons, for a readout */
  hidden: boolean
  /** ms since the last animation frame, at the last check */
  sinceFrameMs: number
}

/** The decision, pure: what the three signals mean together. */
export function classify(o: { hidden: boolean; focused: boolean; sinceFrameMs: number }): PageState {
  const backgrounded = o.hidden || o.sinceFrameMs > STALL_MS
  return { backgrounded, unfocused: !backgrounded && !o.focused, hidden: o.hidden, sinceFrameMs: Math.round(o.sinceFrameMs) }
}

const fns = new Set<(s: PageState) => void>()
let state: PageState = { backgrounded: false, unfocused: false, hidden: false, sinceFrameMs: 0 }
let lastFrame = typeof performance !== 'undefined' ? performance.now() : 0
let started = false

function read(): PageState {
  if (typeof document === 'undefined') return state
  return classify({ hidden: document.visibilityState === 'hidden', focused: document.hasFocus(), sinceFrameMs: performance.now() - lastFrame })
}

/** Re-read now and tell the subscribers if anything moved. Safe to call any time. */
export function checkPage(): PageState {
  start()
  const next = read()
  const moved = next.backgrounded !== state.backgrounded || next.unfocused !== state.unfocused
  state = next
  if (moved) for (const fn of fns) { try { fn(state) } catch { /* a subscriber's problem */ } }
  return state
}

function start(): void {
  if (started || typeof window === 'undefined') return
  started = true
  // the heartbeat: one tiny callback a frame. It stops exactly when the browser stops painting.
  const beat = () => { lastFrame = performance.now(); requestAnimationFrame(beat) }
  requestAnimationFrame(beat)
  for (const ev of ['visibilitychange', 'focus', 'blur', 'pageshow', 'pagehide'] as const) {
    addEventListener(ev, () => checkPage(), ev === 'visibilitychange' ? undefined : true)
  }
  setInterval(checkPage, POLL_MS)
  checkPage()
}

/** The browser is painting nothing here: don't wait on frames, don't hold the screen on. */
export function isBackgrounded(): boolean {
  start()
  // between polls, a hidden document is believed at once; a stall is noticed by the poll
  return state.backgrounded || (typeof document !== 'undefined' && document.hidden)
}

/** Nobody is listening: backgrounded, or another window has focus. The audio rule. */
export function isUnattended(): boolean {
  start()
  return isBackgrounded() || state.unfocused || (typeof document !== 'undefined' && !document.hasFocus())
}

/** Be told when the page goes to or comes back from the background. Returns the unsubscribe. */
export function onPageState(fn: (s: PageState) => void): () => void {
  start()
  fns.add(fn)
  return () => fns.delete(fn)
}

/** the last reading, for probes and the perf panel */
export function pageState(): PageState {
  start()
  return state
}
