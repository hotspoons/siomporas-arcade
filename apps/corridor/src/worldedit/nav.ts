// Where you were: the tab and the world, across a reload.
//
// Rich, 2026-09-28: "would be great if it remembered what tab and what world I was on when the
// page reloads, currently it resets all navigation."
//
// TWO PLACES, and they are not the same thing. The URL is what a LINK carries — paste somebody a
// world in the Bake tab and they get that — and it must win, because it was explicit. Local
// storage is what this browser was last doing, and it is what a bare reload should come back to.
// Storing only in the URL means every navigation writes history and the back button becomes a tab
// undo; storing only in local storage means a shared link lands wherever the other person last was.
//
// The URL is written with `replaceState`, not `pushState`, for the same reason: switching tabs is
// not navigating, and forty tab switches should not be forty presses of the back button to leave.
//
// PURE, so the precedence is a thing a test can state. The DOM lives at the two call sites.

const KEY = 'corridor.worldedit.nav.v1'

export interface Nav {
  mode: string | null
  /** which stage within a mode that has stages — only `world` has, so far */
  step: string | null
  world: string | null
}

/**
 * The four modes that became one.
 *
 * Explore, Index, Define and Bake were four of eleven items along the top, and they are not four
 * things — they are the four stages of making one world (Rich, 2026-09-29: "Explore, define, and
 * bake need to be collapsed into a single item with a multistage wizard form or something").
 * They are now steps inside `world`.
 *
 * THIS MAPPING IS PERMANENT, not a migration to delete later. Every link anybody has pasted into a
 * message says `?mode=bake`, and so does every browser's stored nav. A link that opens the wrong
 * screen — or no screen — is worse than the tab it replaced.
 */
const LEGACY_MODE_STEP: Record<string, { mode: string; step: string }> = {
  explore: { mode: 'world', step: 'explore' },
  // "Index" never said what it was. It is the places you have kept.
  index: { mode: 'world', step: 'places' },
  define: { mode: 'world', step: 'define' },
  bake: { mode: 'world', step: 'bake' },
}

/** Whatever the URL says, which is what a shared link carries. */
export function fromUrl(search: string): Nav {
  const q = new URLSearchParams(search)
  const raw = q.get('mode')
  const moved = raw ? LEGACY_MODE_STEP[raw] : undefined
  if (moved) return { mode: moved.mode, step: q.get('step') ?? moved.step, world: q.get('world') }
  return { mode: raw, step: q.get('step'), world: q.get('world') }
}

/**
 * Where to start: the URL first, then what this browser was last doing.
 *
 * Per FIELD, not per source: a link that names a world and no tab should open that world where you
 * left off, not throw your tab away because the link was silent about it.
 */
export function resolve(
  url: Nav,
  stored: Nav,
  valid: { modes: string[]; steps: string[]; worlds: string[] },
): Nav {
  const pick = (a: string | null, b: string | null, ok: string[]) => {
    for (const v of [a, b]) if (v && ok.includes(v)) return v
    return null
  }
  return {
    mode: pick(url.mode, stored.mode, valid.modes),
    step: pick(url.step, stored.step, valid.steps),
    // the world list is only known after it loads, so an empty list means "do not judge yet"
    world: valid.worlds.length ? pick(url.world, stored.world, valid.worlds) : (url.world ?? stored.world),
  }
}

/** What this browser was last doing. Never throws: a private window has no storage. */
export function load(): Nav {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { mode: null, step: null, world: null }
    const v = JSON.parse(raw) as Partial<Nav>
    // a stored `mode` written before the collapse is read through the same table as a URL,
    // because a browser that was last on Bake has the same claim on being restored as a link does
    const str = (x: unknown) => (typeof x === 'string' ? x : null)
    const moved = str(v.mode) ? LEGACY_MODE_STEP[str(v.mode)!] : undefined
    if (moved) return { mode: moved.mode, step: str(v.step) ?? moved.step, world: str(v.world) }
    return { mode: str(v.mode), step: str(v.step), world: str(v.world) }
  } catch {
    return { mode: null, step: null, world: null }
  }
}

export function save(nav: Nav): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(nav))
  } catch {
    /* a private window has no storage; the URL still carries it for this session */
  }
}

/**
 * The URL for a navigation state — the same one a person can copy out of the bar.
 *
 * Everything else in the query is KEPT. `?assetsvc=` and the rest are how this page is pointed at
 * a service, and a tab switch that dropped them would disconnect the editor from its own backend.
 */
export function toUrl(current: string, nav: Nav): string {
  const q = new URLSearchParams(current)
  if (nav.mode) q.set('mode', nav.mode)
  else q.delete('mode')
  // `step` is only written when it means something. `?mode=assets&step=bake` would be a link that
  // carries a stale answer to a question its own mode does not ask.
  if (nav.step) q.set('step', nav.step)
  else q.delete('step')
  if (nav.world) q.set('world', nav.world)
  else q.delete('world')
  const s = q.toString()
  return s ? `?${s}` : location.pathname
}
