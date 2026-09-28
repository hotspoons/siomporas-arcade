// Does the editor come back to where you were?
//
// Rich, 2026-09-28: "would be great if it remembered what tab and what world I was on when the page
// reloads, currently it resets all navigation."
//
// The interesting part is the precedence, and it is easy to get subtly wrong in a way nobody
// reports: a link that names a world and no tab should open that world where YOU left off, not
// throw your tab away because the link happened to be silent about it. And a remembered tab that
// no longer exists must not open a page with no panel.
import { describe, expect, it } from 'vitest'
import { fromUrl, resolve, toUrl } from '../src/worldedit/nav'

const MODES = ['explore', 'index', 'define', 'bake', 'place', 'stage', 'program', 'shell', 'assets', 'splats']
const WORLDS = ['crofton-triangle', 'arrowhead-farms']
const valid = { modes: MODES, worlds: WORLDS }

describe('fromUrl', () => {
  it('reads what a shared link carries', () => {
    expect(fromUrl('?mode=bake&world=crofton-triangle')).toEqual({ mode: 'bake', world: 'crofton-triangle' })
    expect(fromUrl('')).toEqual({ mode: null, world: null })
  })
})

describe('resolve', () => {
  it('lets the URL win, because it was explicit', () => {
    const r = resolve({ mode: 'bake', world: 'crofton-triangle' }, { mode: 'assets', world: 'arrowhead-farms' }, valid)
    expect(r).toEqual({ mode: 'bake', world: 'crofton-triangle' })
  })

  it('falls back to this browser where the link says nothing', () => {
    expect(resolve({ mode: null, world: null }, { mode: 'assets', world: 'arrowhead-farms' }, valid))
      .toEqual({ mode: 'assets', world: 'arrowhead-farms' })
  })

  it('mixes them FIELD BY FIELD', () => {
    // a link that names a world and no tab opens that world where you left off — throwing the tab
    // away because the link was silent about it is the version of this that feels broken
    expect(resolve({ mode: null, world: 'crofton-triangle' }, { mode: 'stage', world: 'arrowhead-farms' }, valid))
      .toEqual({ mode: 'stage', world: 'crofton-triangle' })
  })

  it('ignores a tab that no longer exists', () => {
    // a stored `places` from before a rename would otherwise open a page with no panel on it
    expect(resolve({ mode: 'places', world: null }, { mode: 'bake', world: null }, valid).mode).toBe('bake')
    expect(resolve({ mode: 'places', world: null }, { mode: 'gone', world: null }, valid).mode).toBeNull()
  })

  it('ignores a world that has been deleted', () => {
    expect(resolve({ mode: null, world: 'deleted' }, { mode: null, world: 'arrowhead-farms' }, valid).world)
      .toBe('arrowhead-farms')
  })

  it('does not judge a world before the list has loaded', () => {
    // an empty list is "not known yet", not "there are none" — judging then would drop the world
    // out of a link every time the page was slow
    expect(resolve({ mode: null, world: 'crofton-triangle' }, { mode: null, world: null }, { modes: MODES, worlds: [] }).world)
      .toBe('crofton-triangle')
  })

  it('comes back with nothing from nothing', () => {
    expect(resolve({ mode: null, world: null }, { mode: null, world: null }, valid)).toEqual({ mode: null, world: null })
  })
})

describe('toUrl', () => {
  it('writes both', () => {
    expect(toUrl('', { mode: 'bake', world: 'crofton-triangle' })).toBe('?mode=bake&world=crofton-triangle')
  })

  it('KEEPS everything else in the query', () => {
    // `?assetsvc=` is how this page is pointed at its backend; a tab switch that dropped it would
    // disconnect the editor from the service it is editing
    const out = toUrl('?assetsvc=%2Fassetsvc&debug=1', { mode: 'shell', world: null })
    expect(out).toContain('assetsvc=%2Fassetsvc')
    expect(out).toContain('debug=1')
    expect(out).toContain('mode=shell')
    expect(out).not.toContain('world=')
  })

  it('replaces rather than appends when it is already there', () => {
    expect(toUrl('?mode=bake&world=a', { mode: 'stage', world: 'b' })).toBe('?mode=stage&world=b')
  })
})
