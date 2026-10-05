// The F6 engine tab, and the one number in it that can rot silently.
//
// ENGINE_INDEX picks an engine by position in a GENERATED catalog. That is the right shape for a
// panel made of sliders and the wrong shape for a durable reference: the catalog is derived from
// the upstream asset tree and sorted by path, so one engine added to `atg-video-1` renumbers
// everything after it and the default quietly becomes a different car. It was wrong once already
// during this work — typed as 11, actually 14 — which is exactly the failure mode this catches,
// because nothing about a wrong index looks wrong.

import { describe, expect, it } from 'vitest'
import { ENGINES } from '@apex/enginesim'
import { ENGINE_INDEX, ENGINE_SHIFT_DOWN_RPM, ENGINE_SHIFT_UP_RPM, ENGINE_REDLINE_RPM,
  ENGINE_IDLE_RPM, TUNE_TABS } from '../src/tuning'

const engineTab = TUNE_TABS.find((tab) => tab.name === 'engine')

describe('the engine tuning tab', () => {
  it('exists, with the gearbox and the voicing', () => {
    expect(engineTab).toBeDefined()
    const titles = engineTab!.sections.map((s) => s.title)
    expect(titles.some((t) => t.includes('gearbox'))).toBe(true)
    expect(titles.some((t) => t.includes('voicing'))).toBe(true)
  })

  it('ENGINE_INDEX still points at the Subaru EJ25', () => {
    expect(ENGINES[ENGINE_INDEX]?.path).toBe('engines/atg-video-1/06_subaru_ej25.mr')
  })

  it('keeps ENGINE_INDEX inside the catalog it indexes', () => {
    const knob = engineTab!.sections.flatMap((s) => s.keys).find((k) => k.name === 'ENGINE_INDEX')
    expect(knob).toBeDefined()
    // A slider that can select past the end of the catalog hands `undefined` to the loader.
    expect(knob!.max).toBe(ENGINES.length - 1)
    expect(knob!.min).toBe(0)
  })

  it('every knob in the tab starts inside its own range', () => {
    // tune() takes the range as an argument, so a default outside it is possible and shows up as a
    // slider pinned to one end that cannot reproduce the value the game is actually running.
    for (const section of engineTab!.sections) {
      for (const knob of section.keys) {
        expect(knob.default, knob.name).toBeGreaterThanOrEqual(knob.min)
        expect(knob.default, knob.name).toBeLessThanOrEqual(knob.max)
      }
    }
  })

  it('the shift points leave room for hysteresis', () => {
    // Upshift and downshift thresholds that meet make the gearbox oscillate, which is a machine gun
    // rather than a car. Drivetrain clamps this at runtime; the defaults should not need clamping.
    expect(ENGINE_SHIFT_DOWN_RPM).toBeLessThan(ENGINE_SHIFT_UP_RPM * 0.9)
    expect(ENGINE_SHIFT_UP_RPM).toBeLessThanOrEqual(ENGINE_REDLINE_RPM)
    expect(ENGINE_IDLE_RPM).toBeLessThan(ENGINE_SHIFT_DOWN_RPM)
  })
})
