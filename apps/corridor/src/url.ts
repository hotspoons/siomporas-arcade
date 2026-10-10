/**
 * THE GAME'S ADDRESS: one place that reads it and one place that writes it.
 *
 *     /#dc-metro-take-2?level=rush-hour&phys=1&lite
 *       └── world ────┘ └── options, a query string INSIDE the hash ──┘
 *
 * Everything after the `#`. The world slug first, then the options as `k=v` pairs, a bare key for
 * a flag (`lite`, `fresh`). Never a `?query` before the `#` — Rich, 2026-10-10: "Don't mix URL
 * params and hashes, pick one or the other, or have the hash take a query string but don't stick
 * the query string before the hash, it looks really janky." The hash, because the world editor's
 * pod serves the game at `/index.html` and the Worker serves it at `/`, and neither server has
 * anything to learn from the options: they are the page's business only.
 *
 * OLD LINKS STILL WORK. `/?stance=…&season=summer#crofton`, `/#/crofton`, `/index.html?level=x#w`
 * and the world editor's `/index.html?site=w` all name the same thing; `read()` folds them in, and
 * `canonicalize()` (main.ts, first thing) rewrites the address bar into the form above with
 * `replaceState`. Where an option is in both places the hash wins: it is the newer form.
 *
 * ONE CATCH THAT COMES WITH THE HASH: changing only the hash does not load a page. `location.href =`
 * a URL that differs from this one only after the `#` scrolls, it does not navigate. So anything
 * that used to rely on a new `?level=` reloading the page goes through `navigate()`, which writes
 * and then reloads, and main.ts reloads on `hashchange` (a hash edited in the address bar, or a
 * probe's `goto` to the same page) — `replaceState` never fires it, so the page's own writes don't.
 *
 * Module-load readers (`site.ts`'s `DATA_BASE`, `LITE`, the stores) run before main.ts can
 * canonicalize anything, which is why `read()` always parses the live location and folds the
 * legacy query in rather than trusting that the rewrite has happened.
 */

/** the two parts of a location this module reads */
export interface Loc {
  search: string
  hash: string
}

export interface GameLocation {
  /** the world, `''` when the address names none */
  slug: string
  /** the options, legacy query folded in */
  params: URLSearchParams
}

/** a value for `set`: null / undefined / false remove the key, true is a bare flag */
export type ParamValue = string | number | boolean | null | undefined

export interface Change {
  /** the world to name; omitted keeps the current one */
  slug?: string
  /** options to set or (null) remove; everything not named is kept */
  set?: Record<string, ParamValue>
}

const live = (): Loc => (typeof location === 'undefined' ? { search: '', hash: '' } : location)

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * The address, as the game means it.
 *
 * The hash is `[/]slug[:mode][?query]`: the slash is the 2026-10-01 form (`#/crofton`), `:mode` is
 * the site editor's (`#crofton:areas`), and neither is part of the world's name. `?site=` is the
 * world editor's old "play" link, which the game never actually read; it names the world here.
 */
export function parse(loc: Partial<Loc> = live()): GameLocation {
  // Partial: a test that stubs `location` with only an origin must still read as "no options"
  const raw = (loc.hash ?? '').replace(/^#/, '')
  const q = raw.indexOf('?')
  const head = q < 0 ? raw : raw.slice(0, q)
  const params = new URLSearchParams(loc.search ?? '')
  if (q >= 0) {
    const fromHash = new URLSearchParams(raw.slice(q + 1))
    for (const k of new Set(fromHash.keys())) params.delete(k)
    for (const [k, v] of fromHash) params.append(k, v)
  }
  let slug = decode(head).replace(/^\/+/, '').split(':')[0].trim()
  const site = params.get('site')
  params.delete('site')
  if (!slug && site) slug = site.trim()
  return { slug, params }
}

// `encodeURIComponent`, minus what a fragment may carry as it is: `data=http://127.0.0.1:5190`
// stays readable. `=` is left alone only in a value (the first `=` splits the pair), and `+`, `&`,
// `#`, `?` and space stay escaped — `+` would come back as a space.
const encKey = (s: string) => encodeURIComponent(s).replace(/%(2F|3A|2C|40)/gi, (m) => decode(m))
const encValue = (s: string) => encodeURIComponent(s).replace(/%(2F|3A|2C|40|3D)/gi, (m) => decode(m))

/** the query part, no `?`: a flag with no value is written bare (`lite`, not `lite=`) */
export function formatQuery(params: URLSearchParams): string {
  const out: string[] = []
  for (const [k, v] of params) out.push(v === '' ? encKey(k) : `${encKey(k)}=${encValue(v)}`)
  return out.join('&')
}

/** the canonical hash for a location, `#` included, or `''` when it names nothing */
export function format(g: { slug?: string; params?: URLSearchParams | Record<string, ParamValue> }): string {
  const params = g.params instanceof URLSearchParams ? g.params : apply({ slug: '', params: new URLSearchParams() }, { set: g.params ?? {} }).params
  const qs = formatQuery(params)
  const slug = encodeURIComponent(g.slug ?? '')
  if (!slug && !qs) return ''
  return `#${slug}${qs ? `?${qs}` : ''}`
}

/** `g` with `change` applied, `g` untouched */
export function apply(g: GameLocation, change: Change): GameLocation {
  const params = new URLSearchParams(g.params)
  for (const [k, v] of Object.entries(change.set ?? {})) {
    if (v === null || v === undefined || v === false) params.delete(k)
    else params.set(k, v === true ? '' : String(v))
  }
  return { slug: change.slug ?? g.slug, params }
}

/** where the page is, as the game means it */
export function read(): GameLocation {
  return parse(live())
}

/** one option, wherever the address carries it; `''` for a bare flag, null when absent */
export function param(name: string): string | null {
  return read().params.get(name)
}

/** is the option present at all (`#w?lite`, `?lite=1`) */
export function hasParam(name: string): boolean {
  return read().params.has(name)
}

/** all the options as a `?k=v` string, for an API that wants `location.search`'s shape */
export function query(): string {
  const qs = formatQuery(read().params)
  return qs ? `?${qs}` : ''
}

/** the world the address names, `''` for none */
export function worldSlug(): string {
  return read().slug
}

/** path + canonical hash for this page with `change` applied: what `write` puts in the bar */
function pathFor(change: Change, path?: string): string {
  return `${path ?? (typeof location === 'undefined' ? '/' : location.pathname)}${format(apply(read(), change))}`
}

/**
 * Change the address bar without loading anything. `replaceState`: switching worlds or clearing a
 * stance is not a step anyone wants Back to undo, and it never fires `hashchange`.
 */
export function write(change: Change = {}): void {
  const next = pathFor(change)
  if (`${location.pathname}${location.search}${location.hash}` === next) return
  history.replaceState(history.state, '', next)
}

/** the absolute URL of this page with `change` applied — a link to share, the bar untouched */
export function href(change: Change = {}): string {
  return `${location.origin}${pathFor(change)}`
}

/**
 * Write and load the page again: what `location.href = u` did when `u` differed in its query. A
 * new level, an MSAA switch — anything that is read once at start-up.
 */
export function navigate(change: Change = {}): void {
  write(change)
  location.reload()
}

/**
 * Rewrite a legacy address (`?k=v#w`, `#/w`, `?site=w`) into the canonical one. Called once at
 * boot; true when the bar changed.
 */
export function canonicalize(): boolean {
  const before = `${location.pathname}${location.search}${location.hash}`
  write()
  return `${location.pathname}${location.search}${location.hash}` !== before
}

/**
 * A stance link's `stance=` value: base64 JSON, standard or URL-safe, and forgiving of a `+` that a
 * hand-built link left unescaped (a query string reads it back as a space).
 */
export function decodeStance<T = unknown>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(atob(raw.replace(/ /g, '+').replace(/-/g, '+').replace(/_/g, '/'))) as T
  } catch {
    return null
  }
}
