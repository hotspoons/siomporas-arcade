// The URL is the app's state, not a decoration on it. `/` is the lobby, `/radrun` is a game, and
// `/radrun/settings/controls` is that game two menus deep — so the browser's Back button escapes a
// nested menu, then the game, then leaves. Nothing else in the app tracks "where am I": the shell
// and the menus both read it from here.
//
// Everything is an absolute path of segments. There is deliberately no relative navigation and no
// pattern matching: three games and a handful of menu screens do not need a routing table.

export type RoutePath = readonly string[]

/** Where a change came from: our own code navigating, or the user's Back/Forward. */
export type RouteSource = 'nav' | 'history'

export type RouteListener = (path: RoutePath, source: RouteSource) => void

function parse(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map(decodeURIComponent)
}

function format(segments: RoutePath): string {
  return '/' + segments.map(encodeURIComponent).join('/')
}

export function samePath(a: RoutePath, b: RoutePath): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i])
}

/** Is `a` equal to, or a leading run of, `b`? */
export function isPrefix(a: RoutePath, b: RoutePath): boolean {
  return a.length <= b.length && a.every((s, i) => s === b[i])
}

/**
 * What has to happen to a menu stack for it to match a URL, as data rather than as side effects.
 *
 *   have    ids of the nested screens on the stack now, root excluded
 *   kept    ids Back set aside, nearest first, so Forward can put them back
 *   want    the nested ids the URL is asking for
 *
 * `clamped` means the URL asked for a screen deeper than anything that can be rebuilt — a cold
 * deep link into `/apex/settings/controls`, typically, where nothing has ever built those screens.
 * The caller corrects the URL down to where it actually got to rather than leaving the address bar
 * describing a screen that is not on the screen.
 */
export function planMenuSync(have: RoutePath, kept: RoutePath, want: RoutePath): { pops: number; pushes: string[]; clamped: boolean } {
  let depth = have.length
  while (depth > 0 && !isPrefix(have.slice(0, depth), want)) depth--
  const pops = have.length - depth

  // Whatever we are about to pop is available to push straight back, ahead of the older trail.
  const pool = [...have.slice(depth).reverse(), ...kept]
  const pushes: string[] = []
  while (depth + pushes.length < want.length) {
    const id = want[depth + pushes.length]
    const i = pool.indexOf(id)
    if (i < 0) break
    pool.splice(i, 1)
    pushes.push(id)
  }
  return { pops, pushes, clamped: depth + pushes.length < want.length }
}

export class Router {
  private segments: string[]
  private readonly listeners = new Set<RouteListener>()

  constructor() {
    this.segments = parse(location.pathname)
    // The entry the page loaded on may have no state of ours (a cold deep link, or a back into the
    // app from another site). Stamp it so every entry we ever see is one of ours.
    history.replaceState({ apex: true }, '', format(this.segments) + location.search + location.hash)
    window.addEventListener('popstate', this.onPop)
  }

  private readonly onPop = (): void => {
    this.segments = parse(location.pathname)
    this.emit('history')
  }

  get path(): RoutePath {
    return this.segments
  }

  /** Navigate, leaving an entry behind for Back to return to. */
  push(path: RoutePath): void {
    if (samePath(path, this.segments)) return
    this.segments = [...path]
    history.pushState({ apex: true }, '', format(this.segments))
    this.emit('nav')
  }

  /** Navigate without leaving an entry — for corrections, not for moves the user made. */
  replace(path: RoutePath): void {
    const changed = !samePath(path, this.segments)
    this.segments = [...path]
    history.replaceState({ apex: true }, '', format(this.segments))
    if (changed) this.emit('nav')
  }

  /**
   * The Back button, pressed from code. Asynchronous: the change arrives later as a `popstate`,
   * through the same path a real Back does. Callers that need the effect now should make it now and
   * let the arriving `popstate` find the work already done — every listener here is written to be
   * idempotent for exactly that reason.
   */
  back(): void {
    history.back()
  }

  subscribe(fn: RouteListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(source: RouteSource): void {
    for (const fn of [...this.listeners]) fn(this.segments, source)
  }

  dispose(): void {
    window.removeEventListener('popstate', this.onPop)
    this.listeners.clear()
  }
}
