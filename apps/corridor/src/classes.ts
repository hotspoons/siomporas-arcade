// The asset library's class vocabulary, on its own.
//
// It lived in `src/ui/assets.ts`, which is right until something that is not the UI needs it — and
// three things now do: `vehicles.ts` and `actorspecs.ts` say which classes get a dynamics document,
// and their tests assert that those lists name classes that really exist.
//
// WHY THAT ASSERTION NEEDS ITS OWN FILE. Importing the vocabulary from the UI module drags the whole
// pane in with it, and `assetsvc.ts` reads `location.search` at module scope, so a Node test that
// merely wants the list of class names dies on `location is not defined`. A vocabulary is data; it
// should not require a DOM to read.
//
// AND WHY THE ASSERTION MATTERS AT ALL: a second, hand-written copy of this list fails SILENTLY. The
// wrong words match nothing, so the Vehicles tab reports an empty fleet while the library is full of
// cars, and no error is raised anywhere. `test/vehicles.test.ts` holds `VEHICLE_CLASSES` against
// this, which is the only reason the mismatch was found at all.

/** Every class an asset may be filed under. The library offers these plus whatever is already used. */
export const KINDS = [
  'hero-car', 'traffic', 'emergency', 'commercial-vehicle', 'pedestrian', 'animal',
  'furniture', 'building', 'building-dressing', 'vegetation', 'signage', 'prop',
  'weapon',
  'race-gate', 'race-marker', 'stop-sign', 'give-way-sign', 'signal', 'power-pole', 'lamp-post', 'street-sign',
]

/*
 * WHAT A THING IS, which is not what it is filed under.
 *
 * Rich, 2026-09-29: "I don't like how they used classes to link catalog types - things from the
 * catalog should be either a prop/furniture/building type of thing, a vehicle, an actor, or a
 * weapon."
 *
 * He is right, and the bug it caused is worth recording. `isVehicle(kind)` was the only thing
 * deciding whether an asset got a dynamics document — so a library of 120 cars whose `kind` had
 * never been filled in was a library of 120 props, with an empty fleet roster beside it and no
 * error anywhere. The two questions had been collapsed into one field, and the field was blank.
 *
 * Separated, they behave differently on purpose:
 *
 *   TYPE is closed, small, and decides CAPABILITY — which documents an asset may have, which
 *   editors it gets, what a level may do with it. Four values, and adding a fifth is a change to
 *   what this engine can represent.
 *
 *   KIND is open and decides DEFAULTS and filing — a `traffic` car starts at different numbers
 *   from a `hero-car`, and the library offers whatever classes are in use, not only these.
 *
 * An unrigged car is still a vehicle. Rich, same day: "Unrigged cars should still be usable as
 * vehicles, the wheels just won't turn." Nothing in here may ask about a mesh or a skeleton.
 */
/**
 * `fixture`: the things the world draws by itself — signs, signals, poles, race gates — which the
 * asset manager can now offer variants of. Rich, 2026-09-30: *"make all of these built-in assets
 * like light poles, power lines, stop signs, street sign components, start/finish lines, and
 * checkpoint gates … fixtures with a few classes … and use different variants in our levels."*
 * A fixture class always has a BUILT-IN (the procedural one); a catalog item of that class is a
 * variant a world can choose instead. See `fixtures.ts`.
 */
export const TYPES = ['prop', 'vehicle', 'actor', 'weapon', 'fixture'] as const
export type AssetType = (typeof TYPES)[number]

export const TYPE_LABEL: Record<AssetType, string> = {
  prop: 'Props',
  vehicle: 'Vehicles',
  actor: 'Actors',
  weapon: 'Weapons',
  fixture: 'Fixtures',
}

/** Which classes belong to which type. The ONLY copy of this mapping; the service does not have one. */
export const CLASSES_BY_TYPE: Record<AssetType, string[]> = {
  vehicle: ['hero-car', 'traffic', 'emergency', 'commercial-vehicle'],
  actor: ['pedestrian', 'animal'],
  weapon: ['weapon'],
  prop: ['furniture', 'building', 'building-dressing', 'vegetation', 'signage', 'prop'],
  fixture: ['race-gate', 'race-marker', 'stop-sign', 'give-way-sign', 'signal', 'power-pole', 'lamp-post', 'street-sign'],
}

const TYPE_OF_CLASS: Record<string, AssetType> = Object.fromEntries(
  (Object.entries(CLASSES_BY_TYPE) as [AssetType, string[]][]).flatMap(([t, ks]) => ks.map((k) => [k, t])),
)

/**
 * What this asset is.
 *
 * A stored `type` wins, because somebody said so — an asset can be a vehicle with a class this
 * build has never heard of, and that must survive. Otherwise it is read off the class, and an
 * unrecognised class is a prop, which is the one answer that is never destructive: a prop places,
 * draws and collides, and the worst that happens is that nobody offers it a gearbox.
 */
export function typeOf(item: { type?: string | null; kind?: string | null }): AssetType {
  const t = item.type
  if (t && (TYPES as readonly string[]).includes(t)) return t as AssetType
  return TYPE_OF_CLASS[item.kind ?? ''] ?? 'prop'
}
