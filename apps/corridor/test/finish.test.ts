// The finish screen's arithmetic: what is on the turntable, how money reads, how the total counts.
import { describe, expect, it } from 'vitest'
import { clockText, countDuration, countUp, defaultShow, formatAmount, lineLabel } from '../src/game/session/finish'

describe('the turntable, when the program did not say', () => {
  it('is the car when driving and the character on foot', () => {
    expect(defaultShow({ driving: true, onFoot: false, hasCar: true })).toBe('car')
    expect(defaultShow({ driving: false, onFoot: true, hasCar: true })).toBe('character')
  })
  it('flying, it is the car when there is one', () => {
    expect(defaultShow({ driving: false, onFoot: false, hasCar: true })).toBe('car')
    expect(defaultShow({ driving: false, onFoot: false, hasCar: false })).toBe('character')
  })
})

describe('money and points', () => {
  it('writes a currency in front, with separators, and cents only when there are cents', () => {
    expect(formatAmount(1340, '$')).toBe('$1,340')
    expect(formatAmount(12.5, '$')).toBe('$12.50')
    expect(formatAmount(2_310_000, '$')).toBe('$2,310,000')
    expect(formatAmount(-40, '$')).toBe('−$40')
    expect(formatAmount(0, '€')).toBe('€0')
  })
  it('no currency is points, and NaN is nothing', () => {
    expect(formatAmount(1340, '')).toBe('1,340 pts')
    expect(formatAmount(NaN, '$')).toBe('$0')
  })
  it('a line with a count says so', () => {
    expect(lineLabel({ label: 'Hits', count: 12 })).toBe('Hits ×12')
    expect(lineLabel({ label: 'Time bonus', count: 1 })).toBe('Time bonus')
    expect(lineLabel({ label: 'Tips' })).toBe('Tips')
  })
})

describe('the count-up', () => {
  it('starts at nothing, rises monotonically, and lands exactly on the total', () => {
    const total = 1340
    const d = countDuration(total)
    expect(countUp(0, total, d)).toBe(0)
    let last = -1
    for (let t = 0; t <= d; t += d / 50) {
      const v = countUp(t, total, d)
      expect(v).toBeGreaterThanOrEqual(last)
      expect(Number.isInteger(v)).toBe(true)
      last = v
    }
    expect(countUp(d, total, d)).toBe(total)
    expect(countUp(d + 5, total, d)).toBe(total)
  })
  it('counts cents for an amount with cents, and lands on them', () => {
    const d = countDuration(49.5)
    expect(countUp(d * 0.5, 49.5, d) * 100 % 1).toBeCloseTo(0, 6)
    expect(countUp(d, 49.5, d)).toBe(49.5)
  })
  it('takes longer for a bigger number, and never long', () => {
    expect(countDuration(20)).toBeLessThan(countDuration(2_000_000))
    expect(countDuration(1e12)).toBeLessThanOrEqual(2.4)
    expect(countDuration(0)).toBeGreaterThanOrEqual(0.9)
  })
})

describe('time', () => {
  it('reads as a clock', () => {
    expect(clockText(0)).toBe('0:00')
    expect(clockText(247.9)).toBe('4:07')
    expect(clockText(3729)).toBe('1:02:09')
    expect(clockText(NaN)).toBe('0:00')
  })
})
