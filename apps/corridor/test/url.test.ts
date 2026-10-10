// The game's address (src/url.ts): one canonical form, `/#world?k=v&flag`, and every old form
// still read — Rich, 2026-10-10: "don't stick the query string before the hash".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as url from '../src/url'

const at = (search: string, hash: string) => url.parse({ search, hash })
const entries = (p: URLSearchParams) => [...p]

describe('parse', () => {
  it('reads the canonical form', () => {
    const g = at('', '#dc-metro-take-2?level=rush&phys=1&lite')
    expect(g.slug).toBe('dc-metro-take-2')
    expect(entries(g.params)).toEqual([['level', 'rush'], ['phys', '1'], ['lite', '']])
    expect(g.params.has('lite')).toBe(true)
  })
  it('reads a bare world, an empty address and options with no world', () => {
    expect(at('', '#crofton')).toEqual({ slug: 'crofton', params: new URLSearchParams() })
    expect(at('', '').slug).toBe('')
    const g = at('', '#?phys=1')
    expect(g.slug).toBe('')
    expect(g.params.get('phys')).toBe('1')
  })
  it('reads the legacy query-before-hash form', () => {
    const g = at('?lite=1&level=crofton-jam', '#crofton-triangle')
    expect(g.slug).toBe('crofton-triangle')
    expect(entries(g.params)).toEqual([['lite', '1'], ['level', 'crofton-jam']])
  })
  it('reads the legacy slash hash, with or without options', () => {
    expect(at('', '#/arrowhead-farms-network').slug).toBe('arrowhead-farms-network')
    const g = at('?season=summer', '#/arrowhead-farms-network')
    expect(g.slug).toBe('arrowhead-farms-network')
    expect(g.params.get('season')).toBe('summer')
    expect(at('', '#/crofton?fresh').params.has('fresh')).toBe(true)
  })
  it("reads the world editor's old ?site= link, and the hash's world beats it", () => {
    const g = at('?site=bowie-racetrack-rd', '')
    expect(g.slug).toBe('bowie-racetrack-rd')
    expect(g.params.has('site')).toBe(false)
    expect(at('?site=a', '#b').slug).toBe('b')
    expect(at('', '#?site=c').slug).toBe('c')
  })
  it("drops the site editor's :mode suffix", () => {
    expect(at('', '#crofton:areas').slug).toBe('crofton')
  })
  it('lets the hash win where an option is in both places', () => {
    const g = at('?phys=0&lite', '#w?phys=1')
    expect(g.params.getAll('phys')).toEqual(['1'])
    expect(g.params.has('lite')).toBe(true)
  })
  it('decodes a percent-encoded slug and survives a broken escape', () => {
    expect(at('', '#my%20world').slug).toBe('my world')
    expect(at('', '#bad%E0%A4%A').slug).toBe('bad%E0%A4%A')
  })
})

describe('format', () => {
  it('writes the world first and the options after it, inside the hash', () => {
    expect(url.format({ slug: 'dc-metro-take-2', params: { level: 'rush', phys: 1 } })).toBe('#dc-metro-take-2?level=rush&phys=1')
  })
  it('writes a flag bare, and nothing at all for an empty address', () => {
    expect(url.format({ slug: 'w', params: { lite: true, fresh: '' } })).toBe('#w?lite&fresh')
    expect(url.format({ slug: '' })).toBe('')
    expect(url.format({ slug: 'w' })).toBe('#w')
    expect(url.format({ params: { phys: 1 } })).toBe('#?phys=1')
  })
  it('drops null, undefined and false', () => {
    expect(url.format({ slug: 'w', params: { a: null, b: undefined, c: false, d: 0 } })).toBe('#w?d=0')
  })
  it('keeps a URL value readable and a base64 stance intact', () => {
    expect(url.format({ slug: 'w', params: { data: 'http://127.0.0.1:5190' } })).toBe('#w?data=http://127.0.0.1:5190')
    const stance = btoa(JSON.stringify({ v: 1, site: 'w', note: '>>>???' })) // has + / and =
    expect(stance).toMatch(/[+/=]/)
    const h = url.format({ slug: 'w', params: { stance, season: 'summer' } })
    expect(h).not.toMatch(/\+/) // a raw + would come back as a space
    const back = at('', h)
    expect(back.params.get('stance')).toBe(stance)
    expect(url.decodeStance<{ site: string }>(back.params.get('stance'))?.site).toBe('w')
  })
  it('round-trips through parse, legacy in, canonical out', () => {
    for (const [search, hash, want] of [
      ['?lite=1&stance=abc&season=summer', '#braddock-i70', '#braddock-i70?lite=1&stance=abc&season=summer'],
      ['?season=summer', '#/arrowhead-farms-network', '#arrowhead-farms-network?season=summer'],
      ['?level=crofton-jam', '#crofton-triangle', '#crofton-triangle?level=crofton-jam'],
      ['?site=bowie-racetrack-rd', '', '#bowie-racetrack-rd'],
      ['?lite&phys=1', '#w', '#w?lite&phys=1'],
      ['', '#w?a=1&b', '#w?a=1&b'],
      ['', '', ''],
    ]) {
      const h = url.format(at(search, hash))
      expect(h, `${search}${hash}`).toBe(want)
      expect(url.format(at('', h)), `idempotent: ${h}`).toBe(want)
    }
  })
})

describe('apply', () => {
  it('sets, replaces in place and removes, leaving the rest', () => {
    const g = at('', '#w?a=1&b=2&c')
    const n = url.apply(g, { set: { a: 9, c: null, d: true } })
    expect(url.format(n)).toBe('#w?a=9&b=2&d')
    expect(url.format(g)).toBe('#w?a=1&b=2&c') // untouched
    expect(url.apply(g, { slug: 'x' }).slug).toBe('x')
  })
})

describe('decodeStance', () => {
  const st = { v: 1, site: 'w', cam: { p: [1, 2, 3] } }
  const b64 = btoa(JSON.stringify(st))
  it('reads standard and URL-safe base64, and a + a query string turned into a space', () => {
    expect(url.decodeStance(b64)).toEqual(st)
    expect(url.decodeStance(b64.replace(/\+/g, '-').replace(/\//g, '_'))).toEqual(st)
    expect(url.decodeStance(b64.replace(/\+/g, ' '))).toEqual(st)
  })
  it('answers null for nothing and for junk', () => {
    expect(url.decodeStance(null)).toBeNull()
    expect(url.decodeStance('')).toBeNull()
    expect(url.decodeStance('not base64 json!')).toBeNull()
  })
})

/** a location + history that behave like the browser's for replaceState */
function fakeBrowser(start: string) {
  let u = new URL(start)
  const replaced: string[] = []
  const loc = {
    get href() { return u.href },
    get origin() { return u.origin },
    get pathname() { return u.pathname },
    get search() { return u.search },
    get hash() { return u.hash },
    reload: vi.fn(),
  }
  const hist = {
    state: null,
    replaceState: (_s: unknown, _t: string, next: string) => {
      u = new URL(next, u)
      replaced.push(next)
    },
  }
  vi.stubGlobal('location', loc)
  vi.stubGlobal('history', hist)
  return { loc, replaced, href: () => u.href }
}

describe('the live address', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('canonicalizes a legacy link in place, keeping the path', () => {
    const b = fakeBrowser('http://localhost:5185/index.html?lite=1&level=crofton-jam#/crofton-triangle')
    expect(url.canonicalize()).toBe(true)
    expect(b.href()).toBe('http://localhost:5185/index.html#crofton-triangle?lite=1&level=crofton-jam')
    expect(url.canonicalize()).toBe(false) // already canonical: no second write
    expect(b.replaced).toHaveLength(1)
  })
  it("canonicalizes the world editor's ?site= link", () => {
    const b = fakeBrowser('http://h/index.html?site=bowie-racetrack-rd')
    url.canonicalize()
    expect(b.href()).toBe('http://h/index.html#bowie-racetrack-rd')
  })
  it('leaves a canonical address alone', () => {
    const b = fakeBrowser('http://h/#w?phys=1')
    expect(url.canonicalize()).toBe(false)
    expect(b.replaced).toHaveLength(0)
  })
  it('reads options from either place before and after the rewrite (load-time readers)', () => {
    fakeBrowser('http://h/?data=http://127.0.0.1:5190&lite#w')
    expect(url.param('data')).toBe('http://127.0.0.1:5190')
    expect(url.hasParam('lite')).toBe(true)
    expect(url.worldSlug()).toBe('w')
    url.canonicalize()
    expect(location.search).toBe('')
    expect(url.param('data')).toBe('http://127.0.0.1:5190')
    expect(url.hasParam('lite')).toBe(true)
    expect(url.query()).toBe('?data=http://127.0.0.1:5190&lite')
    expect(url.param('nope')).toBeNull()
  })
  it('writes with replaceState, and never puts a query before the hash', () => {
    const b = fakeBrowser('http://h/?lite#/a')
    url.write({ slug: 'b', set: { level: 'x' } })
    expect(b.href()).toBe('http://h/#b?lite&level=x')
    url.write({ set: { level: null, stance: null } })
    expect(b.href()).toBe('http://h/#b?lite')
    expect(b.replaced.every((r) => !r.includes('?') || r.indexOf('#') < r.indexOf('?'))).toBe(true)
  })
  it('builds a share link without touching the bar', () => {
    const b = fakeBrowser('http://h/#a?lite')
    expect(url.href({ slug: 'b', set: { stance: 'xyz', season: 'winter' } })).toBe('http://h/#b?lite&stance=xyz&season=winter')
    expect(b.href()).toBe('http://h/#a?lite')
  })
  it('navigate writes and then reloads (a hash change alone loads nothing)', () => {
    const b = fakeBrowser('http://h/#w?level=a')
    url.navigate({ set: { level: 'b' } })
    expect(b.href()).toBe('http://h/#w?level=b')
    expect(b.loc.reload).toHaveBeenCalledTimes(1)
  })
})

describe('without a browser', () => {
  it('reads nothing rather than throwing (Node tests import the stores)', () => {
    vi.unstubAllGlobals()
    expect(typeof location).toBe('undefined')
    expect(url.param('data')).toBeNull()
    expect(url.worldSlug()).toBe('')
  })
  it('reads a stubbed location that has no search or hash (worldthings.test.ts stubs one)', () => {
    vi.stubGlobal('location', { origin: 'http://localhost' })
    expect(url.param('assetsvc')).toBeNull()
    expect(url.worldSlug()).toBe('')
    vi.unstubAllGlobals()
  })
})
