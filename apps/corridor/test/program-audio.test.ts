// `api.audio`: inert with no host, and with one it plays what it is given, refuses rubbish, and
// puts back every override and stops every loop when the program stops.

import { describe, expect, it, vi } from 'vitest'
import { ActorWorld } from '../src/game/actors/actorworld'
import { GameRun, defineGame, type AudioHost, type ProgramHost } from '../src/game/session/program'

function host(audio?: AudioHost): ProgramHost {
  return {
    actors: new ActorWorld(),
    hide: () => {},
    transport: () => {},
    preset: () => {},
    say: () => {},
    playerAt: () => ({ x: 0, y: 0, z: 0 }),
    playerSpeed: () => 0,
    audio,
  } as unknown as ProgramHost
}

describe('api.audio', () => {
  it('does nothing, calmly, without a host', () => {
    const run = new GameRun(host(), defineGame({ setup: (api) => {
      expect(api.audio.play('crash.heavy')).toBe(false)
      expect(api.audio.slots()).toEqual([])
      const l = api.audio.loop('tire.squeal.loop')
      l.set(0.5)
      l.stop()
      api.audio.override('gun.fire', [])
    } }))
    run.start()
    run.stop()
  })

  it('plays, with the options cleaned, and lists the slots', () => {
    const play = vi.fn(() => true)
    const run = new GameRun(host({ play, loop: () => ({ set: () => {}, stop: () => {} }), override: () => {}, slots: () => [{ slot: 'gun.fire', desc: 'a round', clips: 3, loop: false }] }), defineGame({ setup: (api) => {
      expect(api.audio.play('gun.fire', { at: { x: 1, y: 2, z: 3 }, gain: 0.5, rate: NaN })).toBe(true)
      expect(api.audio.play('gun.fire', { at: { x: NaN, y: 0, z: 0 } as never })).toBe(true)
      expect(api.audio.play(7 as never)).toBe(false)
      expect(api.audio.slots()[0].slot).toBe('gun.fire')
    } }))
    run.start()
    expect(play).toHaveBeenCalledTimes(2)
    expect(play.mock.calls[0]).toEqual(['gun.fire', { at: { x: 1, y: 2, z: 3 }, gain: 0.5 }])
    // a bad `at` is dropped, not passed through
    expect(play.mock.calls[1]).toEqual(['gun.fire', {}])
    run.stop()
  })

  it('stops its loops and puts its overrides back when it stops', () => {
    const stop = vi.fn()
    const override = vi.fn()
    const run = new GameRun(host({ play: () => true, loop: () => ({ set: () => {}, stop }), override, slots: () => [] }), defineGame({ setup: (api) => {
      api.audio.loop('tire.squeal.loop').set(1)
      api.audio.override('crash.heavy', ['crash-heavy/slam-1'])
      api.audio.override('crash.heavy', ['crash-heavy/slam-2'])
      api.audio.override('gun.fire', [])
      api.audio.override('gun.hit', 'nope' as never)
      api.audio.override('gun.hit', [1] as never)
    } }))
    run.start()
    expect(override).toHaveBeenCalledTimes(3)
    run.stop()
    expect(stop).toHaveBeenCalledTimes(1)
    const resets = override.mock.calls.filter((c) => c[1] === null).map((c) => c[0]).sort()
    expect(resets).toEqual(['crash.heavy', 'gun.fire'])
  })
})
