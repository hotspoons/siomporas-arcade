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
  world: string | null
}

/** Whatever the URL says, which is what a shared link carries. */
export function fromUrl(search: string): Nav {
  const q = new URLSearchParams(search)
  return { mode: q.get('mode'), world: q.get('world') }
}

/**
 * Where to start: the URL first, then what this browser was last doing.
 *
 * Per FIELD, not per source: a link that names a world and no tab should open that world where you
 * left off, not throw your tab away because the link was silent about it.
 */
export function resolve(url: Nav, stored: Nav, valid: { modes: string[]; worlds: string[] }): Nav {
  const pick = (a: string | null, b: string | null, ok: string[]) => {
    for (const v of [a, b]) if (v && ok.includes(v)) return v
    return null
  }
  return {
    mode: pick(url.mode, stored.mode, valid.modes),
    // the world list is only known after it loads, so an empty list means "do not judge yet"
    world: valid.worlds.length ? pick(url.world, stored.world, valid.worlds) : (url.world ?? stored.world),
  }
}

/** What this browser was last doing. Never throws: a private window has no storage. */
export function load(): Nav {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { mode: null, world: null }
    const v = JSON.parse(raw) as Partial<Nav>
    return { mode: typeof v.mode === 'string' ? v.mode : null, world: typeof v.world === 'string' ? v.world : null }
  } catch {
    return { mode: null, world: null }
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
  if (nav.world) q.set('world', nav.world)
  else q.delete('world')
  const s = q.toString()
  return s ? `?${s}` : location.pathname
}
