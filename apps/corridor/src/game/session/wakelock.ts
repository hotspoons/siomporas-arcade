// The Screen Wake Lock, as a knob.
//
// A long soak — the test rig driving the Beltway for an hour while a probe samples the frame — is
// over the moment the display sleeps: the tab is hidden, requestAnimationFrame stops, and every
// number after that is a tab doing nothing. `SCREEN_WAKE_LOCK` asks the browser to keep the screen
// on while this page is visible (Rich, 2026-10-08). The lock is released by the browser whenever
// the tab is hidden, so it is re-asked for on every return, for as long as the knob says so.
//
// Nothing here is awaited by the frame loop; a browser without the API (or a page that is not
// secure) simply never holds one, and `wakeLockState()` says which.

import { isBackgrounded, onPageState } from '../../world/pageactive'

type Sentinel = { released: boolean; release(): Promise<void>; addEventListener(t: 'release', fn: () => void): void }

let wanted = false
let held: Sentinel | null = null
let pending: Promise<void> | null = null
let lastError = ''
let listening = false

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator && typeof (navigator as { wakeLock?: { request?: unknown } }).wakeLock?.request === 'function'
}

async function acquire(): Promise<void> {
  if (!wanted || held || !supported()) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  try {
    const s = (await (navigator as unknown as { wakeLock: { request(kind: 'screen'): Promise<Sentinel> } }).wakeLock.request('screen')) as Sentinel
    s.addEventListener('release', () => {
      if (held === s) held = null
    })
    held = s
    lastError = ''
  } catch (e) {
    // NotAllowedError when the page is not visible or the platform refuses; said in the state
    lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  }
}

function onVisible(): void {
  if (document.visibilityState === 'visible' && !isBackgrounded() && wanted && !held) void setWakeLock(true)
}

/** Hold the screen on (true) or let it go (false). Idempotent; safe to call every retune. */
export function setWakeLock(on: boolean): Promise<void> {
  wanted = on
  if (!listening && typeof document !== 'undefined') {
    listening = true
    document.addEventListener('visibilitychange', onVisible)
    // and on the page-state poll: a tab reloaded in the background never fires visibilitychange when
    // it comes forward if the browser already called it visible (pageactive.ts)
    onPageState((st) => { if (!st.backgrounded) onVisible() })
  }
  if (!on) {
    const s = held
    held = null
    return s ? s.release().catch(() => {}) : Promise.resolve()
  }
  if (!pending) pending = acquire().finally(() => { pending = null })
  return pending
}

/** What a probe wants to know: is the knob on, is a lock really held, and if not, why. */
export function wakeLockState(): { wanted: boolean; held: boolean; supported: boolean; error: string } {
  return { wanted, held: !!held && !held.released, supported: supported(), error: lastError }
}
