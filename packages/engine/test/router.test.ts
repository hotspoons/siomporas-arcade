import { describe, expect, it } from 'vitest'
import { isPrefix, planMenuSync, samePath } from '../src/app/Router'

describe('samePath / isPrefix', () => {
  it('compares by segment, not by identity', () => {
    expect(samePath(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(samePath(['a'], ['a', 'b'])).toBe(false)
    expect(isPrefix(['a'], ['a', 'b'])).toBe(true)
    expect(isPrefix([], ['a'])).toBe(true)
    expect(isPrefix(['a', 'b'], ['a'])).toBe(false)
    expect(isPrefix(['b'], ['a', 'b'])).toBe(false)
  })
})

describe('planMenuSync', () => {
  it('does nothing when the stack already matches the URL', () => {
    expect(planMenuSync(['settings'], [], ['settings'])).toEqual({ pops: 0, pushes: [], clamped: false })
  })

  it('pops one screen for a Back out of a nested menu', () => {
    expect(planMenuSync(['settings', 'controls'], [], ['settings'])).toEqual({ pops: 1, pushes: [], clamped: false })
  })

  it('pops everything for a Back to the root screen', () => {
    expect(planMenuSync(['settings', 'controls'], [], [])).toEqual({ pops: 2, pushes: [], clamped: false })
  })

  it('pushes a screen back on for Forward, from the trail Back left', () => {
    expect(planMenuSync(['settings'], ['controls'], ['settings', 'controls'])).toEqual({ pops: 0, pushes: ['controls'], clamped: false })
  })

  it('walks forward through several kept screens at once', () => {
    expect(planMenuSync([], ['settings', 'controls'], ['settings', 'controls'])).toEqual({ pops: 0, pushes: ['settings', 'controls'], clamped: false })
  })

  it('clamps a deep link it cannot rebuild, rather than lying in the address bar', () => {
    expect(planMenuSync([], [], ['settings', 'controls'])).toEqual({ pops: 0, pushes: [], clamped: true })
  })

  it('rebuilds as far as it can and clamps the rest', () => {
    expect(planMenuSync([], ['settings'], ['settings', 'controls'])).toEqual({ pops: 0, pushes: ['settings'], clamped: true })
  })

  it('pops to the common ancestor before pushing down the other branch', () => {
    // /apex/settings/controls → /apex/records: shed both, then put records back from the trail.
    expect(planMenuSync(['settings', 'controls'], ['records'], ['records'])).toEqual({ pops: 2, pushes: ['records'], clamped: false })
  })

  it('can re-push a screen it is popping in the same move', () => {
    // Sideways at the same depth, where the target is the screen currently on top.
    expect(planMenuSync(['settings'], [], ['records'])).toEqual({ pops: 1, pushes: [], clamped: true })
  })
})
