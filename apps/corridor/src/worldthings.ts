// Everything a world has that a program can name, in one list.
//
// Rich, 2026-09-29: *"Nothing shows up in the programming world listing except a set of apartments,
// no traffic zones, no stunts, nothing. Let's keep going and get these cleared so we can create an
// actual game!"*
//
// The list beside the code existed to save you opening a JSON file to find out what
// `api.placed('…')` may be given — and it read `placements.json` and nothing else, so the moment
// there were four layers it was answering a quarter of the question. This is the whole answer.
//
// WHY IT IS A PURE FUNCTION OVER DOCUMENTS. The editor fetches four files; a test hands it four
// literals. Nothing here fetches, nothing here draws, so "does a painted zone appear in the list,
// and does clicking it insert a call that exists" is a question with an answer that does not need a
// browser. The panel renders what this returns and knows nothing about zones.
//
// AND EACH ROW CARRIES ITS OWN CALL. A traffic zone is used through `api.traffic.set`, a fixture
// through `api.stunts.show`, a race through `api.races.start` — four layers with four verbs. Making
// the row insert `api.placed(id)` for all of them, or making the person remember which is which, is
// how you get a program that silently refers to nothing.

import type { CourseDoc } from './races'
import type { StuntDoc } from './stunts'
import type { ZoneDoc } from './zones'

export type WorldThingKind = 'placement' | 'traffic' | 'stunt' | 'race'

export interface WorldThing {
  id: string
  kind: WorldThingKind
  /** what it is: an asset id, a piece type, a race kind */
  what: string
  tags: string[]
  /** the expression clicking it inserts, already written for this id */
  insert: string
}

/** The placements file, as much of it as this needs. */
export interface PlacementDoc {
  items?: { id: string; asset: string; tags?: string[] }[]
}

export interface WorldDocs {
  placements?: PlacementDoc | null
  zones?: ZoneDoc | null
  stunts?: StuntDoc | null
  courses?: CourseDoc | null
}

/**
 * The lot, in the order they are drawn.
 *
 * MISSING IS EMPTY, not an error. Most worlds have no stunts and no races; a site that has never
 * been painted has no `zones.json` at all, and a list that throws for the normal case is a list
 * nobody sees.
 */
export function worldThings(docs: WorldDocs): WorldThing[] {
  const out: WorldThing[] = []

  for (const p of docs.placements?.items ?? []) {
    if (!p?.id) continue
    out.push({ id: p.id, kind: 'placement', what: p.asset ?? 'placement', tags: p.tags ?? [], insert: `api.placed('${p.id}')` })
  }

  for (const z of docs.zones?.zones ?? []) {
    if (!z?.id) continue
    const density = z.traffic?.density
    const tags = [z.name, density === undefined ? null : `${Math.round(density * 100)}% busy`].filter(Boolean) as string[]
    // the useful verb for a zone is making it busier: that is what a program does to traffic
    out.push({ id: z.id, kind: 'traffic', what: z.kind ?? 'zone', tags, insert: `api.traffic.set('${z.id}', 0.8, { over: 4 })` })
  }

  for (const f of docs.stunts?.fixtures ?? []) {
    if (!f?.id) continue
    out.push({ id: f.id, kind: 'stunt', what: f.piece ?? 'fixture', tags: f.name ? [f.name] : [], insert: `api.stunts.show('${f.id}', true)` })
  }

  for (const c of docs.courses?.courses ?? []) {
    if (!c?.id) continue
    const tags = [c.name, `${c.gates?.length ?? 0} gates`].filter(Boolean) as string[]
    out.push({ id: c.id, kind: 'race', what: c.kind ?? 'race', tags, insert: `api.races.start('${c.id}')` })
  }

  return out
}

/** How many of each — for a heading, and for a program that wants to know what it is dealing with. */
export function countByKind(things: WorldThing[]): Record<WorldThingKind, number> {
  const out: Record<WorldThingKind, number> = { placement: 0, traffic: 0, stunt: 0, race: 0 }
  for (const t of things) out[t.kind]++
  return out
}
