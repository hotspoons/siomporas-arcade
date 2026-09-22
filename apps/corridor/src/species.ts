// From a species name to a tree you can recognise from the road.
//
// The bake hands the viewer a species mix — `Picea rubens 0.51, Betula papyrifera 0.28, Acer
// rubrum 0.21` — with the genus and FIA's softwood/hardwood flag beside each name, and a canopy
// height per species measured out of THIS corridor's lidar. What it cannot hand over is a shape:
// nothing in LANDFIRE or FIA says what a red spruce looks like. So this file is the one place in
// the flora path where a judgement is written down, and it is written down at the level of the
// GENUS, whose silhouette is the thing a driver actually reads:
//
//   a spruce is a narrow spire, clothed to the ground, with short branches that droop at the tip
//   a fir is the same spire but tighter, with branches that sweep up
//   a pine carries a long clear bole and an open, whorled crown in the top third
//   a redwood is an enormous clear column with a small crown a long way up
//   a cedar is a dense narrow pillar of foliage with no visible trunk
//   a hemlock droops — leader and all
//   an oak is broad and gnarled, a poplar narrow and smooth, a willow weeps
//
// Everything else — WHICH genus stands at a given point, in what proportion, how tall, and whether
// its stand keeps its leaves in November — comes from the data. Twelve entries here replace the
// old `pickVariant`, which had no species input at all and sorted oak / ash / aspen by height.
//
// ez-tree ships four leaf textures (oak, ash, aspen, pine) and four barks (oak, birch, pine,
// willow). That is the whole palette, so a species is recognised by SILHOUETTE and colour, not by
// leaf detail — which is also how it works at 30 m through a windscreen.
import { TreePreset } from '@dgreenheck/ez-tree'
import type { FloraSpecies } from './flora'

/** Which entry of the season palette a tree dresses in. See season.ts. */
export type LeafKind = 'oak' | 'ash' | 'aspen' | 'pine' | 'live'

export interface Archetype {
  id: string
  /** the real tree the numbers below are shaped after, for anyone reading this later */
  after: string
  /** ez-tree preset to start from */
  preset: string
  leaf: LeafKind
  /** evergreen: keeps its canopy through the autumn ramp whatever the hardwoods do */
  evergreen: boolean
  /** applied to the preset's options after loading; `h` is the measured canopy height in metres */
  tune?: (o: any, h: number) => void
}

/** Shorthand: scale a level's branch length, keeping the trunk (level 0) as the height reference. */
function crown(o: any, ratio: number) {
  o.branch.length[1] = o.branch.length[0] * ratio
  o.branch.length[2] = o.branch.length[1] * 0.55
}

// ---------------------------------------------------------------------------------------------
// the conifers. All of them start from ez-tree's Pine preset: one branch level, whorled children
// off a single straight leader, pine bark, pine (needle-spray) billboards. What separates them is
// the length of those branches against the trunk, where on the trunk they start, and which way
// the growth force pulls their tips.

const SPRUCE: Archetype = {
  id: 'spruce',
  after: 'red spruce (Picea rubens) — Acadia is 20 % of it by basal area',
  preset: 'Pine Medium',
  leaf: 'pine',
  evergreen: true,
  tune: (o) => {
    o.branch.start[1] = 0.1 // clothed almost to the ground: a spruce in the open has no clear bole
    crown(o, 0.2) // short branches against a tall leader = the narrow spire
    o.branch.children[0] = 120 // dense whorls, close together
    o.branch.angle[1] = 99 // a degree or two past horizontal, so the branch leaves the trunk level
    o.branch.force.strength = -0.009 // and then the tip is pulled down: the spruce droop
    o.branch.radius[0] = 0.85
    o.branch.taper[0] = 0.55 // a spire tapers hard
    o.leaves.count = 34
    o.leaves.size = 1.2
    o.leaves.angle = 46
  },
}

const FIR: Archetype = {
  id: 'fir',
  after: 'balsam fir (Abies balsamea) — the other half of an Acadian spruce-fir stand',
  preset: 'Pine Medium',
  leaf: 'pine',
  evergreen: true,
  tune: (o) => {
    o.branch.start[1] = 0.08
    crown(o, 0.17) // narrower than the spruce
    o.branch.children[0] = 140
    o.branch.angle[1] = 84 // swept UP, not down: the fir's branches rise at the tip
    o.branch.force.strength = 0.004
    o.branch.radius[0] = 0.8
    o.branch.taper[0] = 0.5
    o.leaves.count = 38
    o.leaves.size = 1.1
  },
}

const PINE: Archetype = {
  id: 'pine',
  after: 'eastern white / pitch / ponderosa pine (Pinus) — a long bare bole and an open crown',
  preset: 'Pine Medium',
  leaf: 'pine',
  evergreen: true,
  tune: (o, h) => {
    // the bole clears further up on a big tree and barely at all on a scrub pine
    o.branch.start[1] = Math.min(0.62, 0.3 + h / 90)
    crown(o, 0.46) // long branches: a pine crown is wide and see-through
    o.branch.children[0] = 34
    o.branch.angle[1] = 72 // upswept
    o.branch.gnarliness[1] = 0.22 // and kinked — pine limbs are never straight
    o.branch.force.strength = 0.002
    o.branch.radius[0] = 1.1
    o.leaves.count = 26
    o.leaves.size = 1.7
  },
}

const DOUGLAS_FIR: Archetype = {
  id: 'douglas-fir',
  after: 'Douglas-fir (Pseudotsuga menziesii) — a tall narrow cone over a clear lower trunk',
  preset: 'Pine Medium',
  leaf: 'pine',
  evergreen: true,
  tune: (o, h) => {
    o.branch.start[1] = Math.min(0.5, 0.16 + h / 160)
    crown(o, 0.25)
    o.branch.children[0] = 100
    o.branch.angle[1] = 92
    o.branch.force.strength = -0.004
    o.branch.radius[0] = 1.15
    o.branch.taper[0] = 0.6
    o.leaves.count = 32
    o.leaves.size = 1.35
  },
}

const HEMLOCK: Archetype = {
  id: 'hemlock',
  after: 'eastern / western hemlock (Tsuga) — the tree whose leading shoot nods over',
  preset: 'Pine Medium',
  leaf: 'pine',
  evergreen: true,
  tune: (o) => {
    o.branch.start[1] = 0.12
    crown(o, 0.28)
    o.branch.children[0] = 105
    o.branch.angle[1] = 104
    o.branch.force.strength = -0.013 // the whole tree droops, which is what names it at distance
    o.branch.gnarliness[0] = 0.1 // including the leader
    o.branch.radius[0] = 0.9
    o.leaves.count = 34
    o.leaves.size = 1.25
  },
}

const CEDAR: Archetype = {
  id: 'cedar',
  after: 'northern white-cedar / incense-cedar / juniper — a solid pillar of foliage, no trunk showing',
  preset: 'Pine Medium',
  leaf: 'pine',
  evergreen: true,
  tune: (o) => {
    o.branch.start[1] = 0.04
    crown(o, 0.22)
    o.branch.children[0] = 150
    o.branch.angle[1] = 72
    o.branch.force.strength = 0.006
    o.branch.radius[0] = 0.75
    o.branch.taper[0] = 0.62
    o.leaves.count = 44
    o.leaves.size = 1.15
  },
}

const REDWOOD: Archetype = {
  id: 'redwood',
  after: 'coast redwood (Sequoia sempervirens) — a 3 m column of bark with a small crown 40 m up',
  preset: 'Pine Medium',
  leaf: 'pine',
  evergreen: true,
  tune: (o, h) => {
    // the defining fact about a redwood from a road is that most of what you see is trunk
    o.branch.start[1] = Math.min(0.72, 0.5 + h / 200)
    crown(o, 0.16)
    o.branch.children[0] = 70
    o.branch.angle[1] = 88
    o.branch.force.strength = -0.003
    o.branch.radius[0] = 1.9 // and that the trunk is enormous
    o.branch.taper[0] = 0.86 // a clear bole barely tapers over its first thirty metres
    o.branch.sections[0] = 14
    o.leaves.count = 30
    o.leaves.size = 1.15
  },
}

const LARCH: Archetype = {
  id: 'larch',
  after: 'tamarack (Larix laricina) — needles, and the only conifer here that turns gold and drops',
  preset: 'Pine Medium',
  leaf: 'aspen', // the palette entry that goes yellow in autumn and bare in winter
  evergreen: false,
  tune: (o) => {
    o.branch.start[1] = 0.14
    crown(o, 0.24)
    o.branch.children[0] = 90
    o.branch.angle[1] = 96
    o.branch.force.strength = -0.005
    o.leaves.count = 26
    o.leaves.size = 1.2
  },
}

// ---------------------------------------------------------------------------------------------
// the broadleaves

const OAK: Archetype = {
  id: 'oak',
  after: 'white / red oak (Quercus) — the mid-Atlantic default, and it was the only tree we had',
  preset: 'Oak Medium',
  leaf: 'oak',
  evergreen: false,
}

const OAK_BIG: Archetype = {
  id: 'oak-large',
  after: 'an open-grown oak over 22 m',
  preset: 'Oak Large',
  leaf: 'oak',
  evergreen: false,
}

const LIVE_OAK: Archetype = {
  id: 'live-oak',
  after: 'coast live oak (Quercus agrifolia), tanoak, California bay — broadleaf and EVERGREEN',
  preset: 'Oak Medium',
  leaf: 'live',
  evergreen: true,
  tune: (o) => {
    // a live oak is wider than it is tall, and leans away from the wind off the sea
    crown(o, 0.9)
    o.branch.angle[1] = 62
    o.branch.gnarliness[1] = 0.34
    o.branch.children[0] = 9
    o.leaves.size *= 0.8
    o.leaves.count = Math.round(o.leaves.count * 1.25) // it never thins out
  },
}

const HARDWOOD: Archetype = {
  id: 'hardwood',
  after: 'maple, beech, sweetgum, hickory, basswood — the generic closed-canopy broadleaf',
  preset: 'Ash Medium',
  leaf: 'ash',
  evergreen: false,
}

const HARDWOOD_SMALL: Archetype = {
  id: 'hardwood-small',
  after: 'an understorey broadleaf under 8 m',
  preset: 'Ash Small',
  leaf: 'ash',
  evergreen: false,
}

const ASPEN: Archetype = {
  id: 'aspen',
  after: 'quaking / bigtooth aspen, cottonwood (Populus) — narrow, pale, restless',
  preset: 'Aspen Medium',
  leaf: 'aspen',
  evergreen: false,
}

const BIRCH: Archetype = {
  id: 'birch',
  after: 'paper / yellow birch (Betula) — 11 % of Acadia by basal area, and it is the white trunks you see',
  preset: 'Aspen Medium',
  leaf: 'aspen',
  evergreen: false,
  tune: (o) => {
    // the Aspen preset is already birch-barked; what separates the two from a car is that a birch
    // carries real branches out sideways where an aspen is a broom on a pole
    crown(o, 0.42)
    o.branch.children[0] = 15
    o.branch.gnarliness[1] = 0.26
    o.branch.angle[1] = 58
    o.bark.tint = 0xf4f1ea
  },
}

const WILLOW: Archetype = {
  id: 'willow',
  after: 'black willow, alder (Salix, Alnus) — the wet ground beside the culverts',
  preset: 'Ash Medium',
  leaf: 'ash',
  evergreen: false,
  tune: (o) => {
    o.bark.type = 'willow'
    o.branch.angle[1] = 96
    o.branch.force.strength = -0.012
    crown(o, 0.8)
  },
}

export const ARCHETYPES: Archetype[] = [SPRUCE, FIR, PINE, DOUGLAS_FIR, HEMLOCK, CEDAR, REDWOOD, LARCH, OAK, OAK_BIG, LIVE_OAK, HARDWOOD, HARDWOOD_SMALL, ASPEN, BIRCH, WILLOW]

/** Genus -> silhouette. FIA gives the genus; this says what that genus looks like. */
const BY_GENUS: Record<string, Archetype> = {
  Picea: SPRUCE,
  Abies: FIR,
  Pinus: PINE,
  Pseudotsuga: DOUGLAS_FIR,
  Tsuga: HEMLOCK,
  Thuja: CEDAR,
  Chamaecyparis: CEDAR,
  Calocedrus: CEDAR,
  Juniperus: CEDAR,
  Cupressus: CEDAR,
  Hesperocyparis: CEDAR,
  Taxus: CEDAR,
  Torreya: CEDAR,
  Sequoia: REDWOOD,
  Sequoiadendron: REDWOOD,
  Taxodium: REDWOOD,
  Larix: LARCH,
  Quercus: OAK,
  Lithocarpus: LIVE_OAK,
  Notholithocarpus: LIVE_OAK,
  Umbellularia: LIVE_OAK,
  Arbutus: LIVE_OAK,
  Chrysolepis: LIVE_OAK,
  Populus: ASPEN,
  Betula: BIRCH,
  Salix: WILLOW,
  Alnus: WILLOW,
}

/**
 * The silhouette for one species, in one stand.
 *
 * Three inputs, and only the last of them is written down here:
 *   - the GENUS, from FIA's REF_SPECIES, via the bake;
 *   - the stand's LEAF CYCLE, from LANDFIRE's EVT_SBCLS, via the bake — this is what tells a coast
 *     live oak from a white oak, because they are the same genus and the difference is that one
 *     stand is filed as "Evergreen sparse tree canopy" and the other as "Deciduous closed";
 *   - the measured canopy HEIGHT, from this corridor's own lidar, which only chooses between the
 *     large and small variants of the same silhouette.
 */
export function archetypeFor(sp: FloraSpecies, evergreenBroadleaf: boolean, h: number): Archetype {
  const a = BY_GENUS[sp.genus]
  if (a) {
    // a broadleaf genus in a stand LANDFIRE calls evergreen AND files under a Hardwood physiognomy
    // is an evergreen broadleaf — a coast live oak, a madrone — and must not go bare in November.
    // Both halves matter: "Acadian Low-Elevation Spruce-Fir Forest" is an evergreen stand too, and
    // the paper birch in it is emphatically deciduous. That version of this test turned 10 % of
    // Mount Desert Island into live oaks (probes/corridor-flora.mjs, first run).
    if (!sp.softwood && evergreenBroadleaf && !a.evergreen) return LIVE_OAK
    if (a === OAK && h > 22) return OAK_BIG
    return a
  }
  if (sp.softwood) return h > 45 ? REDWOOD : PINE // an unknown conifer is a pine unless it is huge
  if (evergreenBroadleaf) return LIVE_OAK
  return h < 8 ? HARDWOOD_SMALL : HARDWOOD
}

/** ez-tree's preset table, plus the archetype's own derivation, as one options object. */
export function optionsFor(a: Archetype, h: number): any {
  const o = JSON.parse(JSON.stringify((TreePreset as Record<string, unknown>)[a.preset]))
  // the presets are terse: fields they leave out fall back to TreeOptions' defaults inside ez-tree,
  // so a tune() has to be able to assume the objects it touches exist
  o.branch ??= {}
  for (const k of ['angle', 'children', 'gnarliness', 'length', 'radius', 'sections', 'segments', 'start', 'taper', 'twist']) o.branch[k] ??= {}
  o.branch.force ??= { direction: { x: 0, y: 1, z: 0 }, strength: 0.01 }
  o.leaves ??= {}
  o.bark ??= {}
  a.tune?.(o, h)
  return o
}
