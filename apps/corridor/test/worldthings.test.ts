// Does the list beside the code show everything the world has?
//
// Rich, 2026-09-29: *"Nothing shows up in the programming world listing except a set of apartments,
// no traffic zones, no stunts, nothing."* It listed placements and nothing else. The point of the
// list is that you do not have to open a JSON file to find out what a program may be given, so a
// list that covers one layer of four is worse than none — it tells you the others are empty.
import { describe, expect, it } from 'vitest'
import { countByKind, worldThings } from '../src/game/world/worldthings'

const docs = {
  placements: { items: [{ id: 'p-01', asset: 'apartments-02', tags: ['apartments'] }] },
  zones: { version: 1 as const, zones: [{ id: 'z-01', name: 'Main street', kind: 'traffic' as const, polygon: [[0, 0], [1, 0], [1, 1]] as [number, number][], traffic: { density: 0.6 } }] },
  stunts: { version: 1 as const, fixtures: [{ id: 'sx-01', name: 'The loop', piece: 'loop', at: [0, 0] as [number, number], yaw_deg: 0 }] },
  courses: { version: 1 as const, courses: [{ id: 'r-01', name: 'The stage', kind: 'stage' as const, gates: [] }] },
}

describe('what a program can name in this world', () => {
  it('lists every layer, not just the placements', () => {
    expect(countByKind(worldThings(docs))).toEqual({ placement: 1, traffic: 1, stunt: 1, race: 1 })
  })

  /*
   * AND EACH ROW INSERTS THE CALL THAT USES IT. Four layers have four verbs; a row that pasted
   * `api.placed('z-01')` for a traffic zone would type-check against nothing and do nothing.
   */
  it('gives each one the call that actually takes it', () => {
    const by = Object.fromEntries(worldThings(docs).map((t) => [t.kind, t.insert]))
    expect(by.placement).toBe("api.placed('p-01')")
    expect(by.traffic).toBe("api.traffic.set('z-01', 0.8, { over: 4 })")
    expect(by.stunt).toBe("api.stunts.show('sx-01', true)")
    expect(by.race).toBe("api.races.start('r-01')")
  })

  it('says what each one is, beside its id', () => {
    const things = worldThings(docs)
    expect(things.find((t) => t.id === 'sx-01')?.what).toBe('loop')
    expect(things.find((t) => t.id === 'z-01')?.tags).toContain('60% busy')
  })

  /*
   * A MISSING FILE IS THE NORMAL CASE. Most worlds have no stunts and no races, and the editor
   * fetches four documents of which three routinely 404. An empty list for those is right; an
   * exception would take the whole list down and show nothing at all — which is the reported bug.
   */
  it('is empty rather than broken when a world has none of something', () => {
    expect(worldThings({})).toEqual([])
    expect(worldThings({ zones: null, stunts: undefined, courses: null })).toEqual([])
    expect(worldThings({ placements: { items: undefined } })).toEqual([])
  })
})
