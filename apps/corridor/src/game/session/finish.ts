// The finish screen's arithmetic: what stands on the turntable, how money is written, how the
// total counts up. Pure, so the parts a player reads off the screen are played in a test
// (test/finish.test.ts) rather than squinted at in a screenshot.
//
// The screen itself is ui/finishscreen.ts; what a program says about its ending is `FinishResult`
// in program.ts.
import type { FinishShow } from './program'

/**
 * What stands on the turntable when the program did not say. Rich, 2026-10-10: "defaults to
 * showing the hero car or main character depending on game mode" — the car when driving, the
 * character on foot. Flying (the free camera, a craft) is neither; the car is the hero of every
 * level that has one, so it is the car when there is one, and the character when there is not.
 */
export function defaultShow(s: { driving: boolean; onFoot: boolean; hasCar: boolean }): FinishShow {
  if (s.driving) return 'car'
  if (s.onFoot) return 'character'
  return s.hasCar ? 'car' : 'character'
}

/**
 * An amount as the screen writes it. A currency goes in front and gets thousands separators and
 * cents only when there are cents ("$1,340", "$12.50"); no currency is points ("1,340 pts").
 * Negative is a loss, written "−$40", with a real minus.
 */
export function formatAmount(n: number, currency: string): string {
  if (!Number.isFinite(n)) return currency ? `${currency}0` : '0 pts'
  const cents = Math.abs(n - Math.round(n)) > 0.004
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })
  const sign = n < 0 ? '−' : ''
  return currency ? `${sign}${currency}${body}` : `${sign}${body} pts`
}

/** How long the count-up takes, s: longer for a bigger number, never a wait. */
export function countDuration(total: number): number {
  const mag = Math.log10(Math.abs(total) + 1)
  return Math.min(2.4, Math.max(0.9, 0.7 + mag * 0.3))
}

/**
 * The number on screen `t` seconds into the count-up: ease-out, so it races and then settles, and
 * exactly `total` at the end — a count-up that lands a cent short is the one thing everybody sees.
 * Whole numbers count in whole numbers; an amount with cents counts in cents.
 */
export function countUp(t: number, total: number, duration = countDuration(total)): number {
  if (!(t > 0)) return 0
  if (t >= duration) return total
  const k = t / duration
  const e = 1 - (1 - k) ** 3
  const v = total * e
  const cents = Math.abs(total - Math.round(total)) > 0.004
  return cents ? Math.round(v * 100) / 100 : Math.round(v)
}

/** Run seconds as a clock: "4:07", or "1:02:09" past the hour. */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** A breakdown row's label, with the count when there was more than one: "Hits ×12". */
export function lineLabel(l: { label: string; count?: number }): string {
  return l.count && l.count > 1 ? `${l.label} ×${l.count}` : l.label
}
