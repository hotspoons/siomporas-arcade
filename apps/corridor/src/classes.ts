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
  'furniture', 'building-dressing', 'vegetation', 'signage', 'prop',
  'weapon',
]
