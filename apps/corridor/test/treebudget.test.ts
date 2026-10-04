// THE ADAPTIVE NEAR-TREE BUDGET.
//
// The near models are the whole frame cost of a wood, so the budget spends that cost where the eye
// is: it counts the trees around the camera and picks the near radius that would seat roughly
// `models` of them, then a slow loop trims it down when the machine cannot hold its target. The
// checks here pin the parts a probe cannot see: the count-to-radius law, the attenuator's three
// positions, and that the loop both falls under load and comes back when the load does.

import { describe, expect, it } from 'vitest'
import { TreeBudget, type TreeBudgetConfig } from '../src/world/treebudget'

const make = (over: Partial<TreeBudgetConfig> = {}): TreeBudget =>
  new TreeBudget(() => ({ adapt: 0, models: 200, ms: 16, ...over }))

/** run the closed loop for `n` frames of `ms` each */
const run = (b: TreeBudget, n: number, ms: number): void => {
  for (let i = 0; i < n; i++) b.frame(ms)
}

describe('TreeBudget', () => {
  it('derives the level from the tree count', () => {
    const b = make()
    b.trees(800, 1000, 100)
    run(b, 400, 16)
    // 800 trees against a budget of 200 models: the footprint halves, so the radius does
    expect(b.stats().feed).toBeCloseTo(0.5, 3)
    expect(b.q()).toBeCloseTo(0.5, 2)
    expect(b.radius(100)).toBeCloseTo(50, 1)

    const sparse = make()
    sparse.trees(50, 1000, 100)
    run(sparse, 400, 16)
    expect(sparse.stats().feed).toBeCloseTo(2, 3)
    expect(sparse.radius(100)).toBeCloseTo(200, 1)
  })

  it('attenuates the departure, and -1 pins the near field to the knobs', () => {
    const level = (adapt: number): number => {
      const b = make({ adapt })
      b.trees(800, 1000, 100)
      run(b, 400, 16)
      return b.q()
    }
    expect(level(0)).toBeCloseTo(0.5, 2)
    expect(level(-1)).toBeCloseTo(1, 3)
    // +1 doubles the departure: 1 + (0.5 - 1) * 2 = 0, clamped to the floor
    expect(level(1)).toBeLessThan(0.35)
  })

  it('trims down under sustained over-budget frames, then recovers', () => {
    const b = make()
    b.trees(800, 1000, 100)
    run(b, 60, 16) // settle the feed-forward on a 16 ms floor
    const before = b.stats()
    run(b, 120, 40) // the frames blow past the floor + the target
    const loaded = b.stats()
    expect(loaded.trim).toBeLessThan(before.trim)
    expect(loaded.q).toBeLessThan(before.q)

    run(b, 400, 16) // the load clears
    const recovered = b.stats()
    expect(recovered.trim).toBeGreaterThan(loaded.trim)
    expect(recovered.q).toBeGreaterThan(loaded.q)
  })

  it('follows the radius down with the capacity, but never past the knob', () => {
    const b = make({ adapt: 0 })
    b.trees(800, 1000, 100)
    run(b, 400, 16) // q ≈ 0.5
    expect(b.capacity(90)).toBeLessThan(90)
    expect(b.capacity(90)).toBeGreaterThan(8)

    const full = make()
    full.trees(50, 1000, 100)
    run(full, 400, 16) // q > 1, so capacity stays at the knob
    expect(full.capacity(90)).toBe(90)
  })

  it('clamps the radius, and treats no trees as maximum detail', () => {
    const b = make()
    b.trees(0, 1000, 600)
    run(b, 400, 16)
    expect(b.stats().feed).toBeGreaterThan(2)
    expect(b.radius(600)).toBeLessThanOrEqual(320)
    expect(b.radius(100)).toBeGreaterThanOrEqual(12)
  })
})
