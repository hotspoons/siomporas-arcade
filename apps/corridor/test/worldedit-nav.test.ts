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

const MODES = ['world', 'place', 'stage', 'assets', 'program', 'shell', 'agent', 'splats']
const STEPS = ['explore', 'places', 'define', 'bake']
const WORLDS = ['crofton-triangle', 'arrowhead-farms']
const valid = { modes: MODES, steps: STEPS, worlds: WORLDS }

describe('fromUrl', () => {
  it('reads what a shared link carries', () => {
    expect(fromUrl('?mode=assets&world=crofton-triangle')).toEqual({ mode: 'assets', step: null, world: 'crofton-triangle' })
    expect(fromUrl('')).toEqual({ mode: null, step: null, world: null })
  })

  it('reads a stage', () => {
    expect(fromUrl('?mode=world&step=bake')).toEqual({ mode: 'world', step: 'bake', world: null })
  })
})

/*
 * THE LINKS PEOPLE ALREADY HAVE.
 *
 * Explore, Index, Define and Bake were four top-level modes until 2026-09-29 and are now four
 * stages inside `world`. Every link pasted into a message before that says `?mode=bake`, and so
 * does every browser that had been using it. A link that opens the wrong screen — or no screen,
 * which is what an unrecognised mode gives you — is worse than the tab it replaced.
 */
describe('a link written before the four became one', () => {
  it('lands on the stage it named', () => {
    expect(fromUrl('?mode=bake&world=crofton-triangle'))
      .toEqual({ mode: 'world', step: 'bake', world: 'crofton-triangle' })
    expect(fromUrl('?mode=define')).toEqual({ mode: 'world', step: 'define', world: null })
    expect(fromUrl('?mode=explore')).toEqual({ mode: 'world', step: 'explore', world: null })
  })

  it('sends `index` to Places, which is what it always held', () => {
    expect(fromUrl('?mode=index')).toEqual({ mode: 'world', step: 'places', world: null })
  })

  it('and it survives `resolve`, which is where an unrecognised mode would have been dropped', () => {
    // the whole point: `bake` is not in MODES any more, so without the mapping this is `null` and
    // the page opens on whatever the default is, silently
    expect(resolve(fromUrl('?mode=bake'), { mode: null, step: null, world: null }, valid))
      .toEqual({ mode: 'world', step: 'bake', world: null })
  })

  it('an explicit step still wins over the one the old mode implied', () => {
    expect(fromUrl('?mode=bake&step=define').step).toBe('define')
  })
})

describe('resolve', () => {
  it('lets the URL win, because it was explicit', () => {
    const r = resolve({ mode: 'stage', step: null, world: 'crofton-triangle' }, { mode: 'assets', step: null, world: 'arrowhead-farms' }, valid)
    expect(r).toEqual({ mode: 'stage', step: null, world: 'crofton-triangle' })
  })

  it('falls back to this browser where the link says nothing', () => {
    expect(resolve({ mode: null, step: null, world: null }, { mode: 'assets', step: null, world: 'arrowhead-farms' }, valid))
      .toEqual({ mode: 'assets', step: null, world: 'arrowhead-farms' })
  })

  it('mixes them FIELD BY FIELD', () => {
    // a link that names a world and no tab opens that world where you left off — throwing the tab
    // away because the link was silent about it is the version of this that feels broken
    expect(resolve({ mode: null, step: null, world: 'crofton-triangle' }, { mode: 'stage', step: null, world: 'arrowhead-farms' }, valid))
      .toEqual({ mode: 'stage', step: null, world: 'crofton-triangle' })

    // and the stage mixes the same way: a link to the World mode with no stage keeps yours
    expect(resolve({ mode: 'world', step: null, world: null }, { mode: 'assets', step: 'bake', world: null }, valid).step)
      .toBe('bake')
  })

  it('ignores a tab that no longer exists', () => {
    // a stored `places` from before a rename would otherwise open a page with no panel on it
    expect(resolve({ mode: 'gone', step: null, world: null }, { mode: 'stage', step: null, world: null }, valid).mode).toBe('stage')
    expect(resolve({ mode: 'gone', step: null, world: null }, { mode: 'alsogone', step: null, world: null }, valid).mode).toBeNull()
    // and a stage that no longer exists does not open a mode with no panel in it either
    expect(resolve({ mode: 'world', step: 'index', world: null }, { mode: null, step: null, world: null }, valid).step).toBeNull()
  })

  it('ignores a world that has been deleted', () => {
    expect(resolve({ mode: null, step: null, world: 'deleted' }, { mode: null, step: null, world: 'arrowhead-farms' }, valid).world)
      .toBe('arrowhead-farms')
  })

  it('does not judge a world before the list has loaded', () => {
    // an empty list is "not known yet", not "there are none" — judging then would drop the world
    // out of a link every time the page was slow
    expect(resolve({ mode: null, step: null, world: 'crofton-triangle' }, { mode: null, step: null, world: null }, { modes: MODES, steps: STEPS, worlds: [] }).world)
      .toBe('crofton-triangle')
  })

  it('comes back with nothing from nothing', () => {
    expect(resolve({ mode: null, step: null, world: null }, { mode: null, step: null, world: null }, valid))
      .toEqual({ mode: null, step: null, world: null })
  })
})

describe('toUrl', () => {
  it('writes both', () => {
    expect(toUrl('', { mode: 'assets', step: null, world: 'crofton-triangle' })).toBe('?mode=assets&world=crofton-triangle')
    expect(toUrl('', { mode: 'world', step: 'bake', world: 'a' })).toBe('?mode=world&step=bake&world=a')
  })

  it('KEEPS everything else in the query', () => {
    // `?assetsvc=` is how this page is pointed at its backend; a tab switch that dropped it would
    // disconnect the editor from the service it is editing
    const out = toUrl('?assetsvc=%2Fassetsvc&debug=1', { mode: 'shell', step: null, world: null })
    expect(out).toContain('assetsvc=%2Fassetsvc')
    expect(out).toContain('debug=1')
    expect(out).toContain('mode=shell')
    expect(out).not.toContain('world=')
  })

  it('replaces rather than appends when it is already there', () => {
    expect(toUrl('?mode=world&world=a', { mode: 'stage', step: null, world: 'b' })).toBe('?mode=stage&world=b')

  })

  it('drops a stage that the new mode does not have, rather than carrying a stale answer', () => {
    // `?mode=assets&step=bake` is a link that says which stage of world-building the sender was on
    // when they opened the asset library, which is not a thing anybody meant to share
    expect(toUrl('?mode=world&step=bake', { mode: 'assets', step: null, world: null })).toBe('?mode=assets')
  })
})
