// The palette of prebuilt road: pick a scene and you get that stretch's road
// width, shoulders, guardrail, roadside mix and landmarks — the same recipes the
// built-in stages are made of, broken out so a track can be laid as "coast for a
// kilometre, then fields, then downtown".
//
// A scene deliberately says nothing about the hour or the weather; that is the
// vibe's job (see vibes.ts). So there is one `city` scene, not a day one and a
// night one: put the night vibe on it and the same street is a night street.

import type { Theme } from '../sim/Road'

export interface SceneDef {
  id: string
  name: string
  group: 'Coastal' | 'Country' | 'Arid' | 'Mountain' | 'Urban'
  desc: string
  theme: Theme
}

/** Roadside entry shorthand: kind, weight, offset range. */
const r = (kind: string, weight: number, minOffset: number, maxOffset: number, extra: { scale?: number; collide?: boolean } = {}) => ({ kind, weight, minOffset, maxOffset, ...extra })

function scene(id: string, name: string, group: SceneDef['group'], desc: string, theme: Omit<Theme, 'id'>): SceneDef {
  return { id, name, group, desc, theme: { ...theme, id } }
}

export const SCENES: Record<string, SceneDef> = {
  coast: scene('coast', 'Palm coast', 'Coastal', 'Three lanes, guardrail, palms and diners. Takes an ocean front happily.', {
    palette: 'coast',
    backdrop: 'sea',
    lanes: 3,
    rails: true,
    density: 0.3,
    roadside: [r('palm', 5, 1.2, 2.1), r('palmTall', 3, 1.25, 2.2), r('palmBend', 2, 1.2, 2.0), r('bush', 3, 1.12, 1.7, { scale: 1.3 }), r('rock', 1, 1.3, 2.2), r('flower', 2, 1.08, 1.5, { collide: false, scale: 1.6 })],
    landmarks: ['signCoast', 'diner', 'billboard', 'motel', 'gas', 'lightpost', 'signDrive', 'billboardLow'],
    landmarkEvery: 55,
  }),
  strip: scene('strip', 'Ocean strip', 'Coastal', 'The motel strip: no rail, dense palms, signage every few seconds.', {
    palette: 'coast',
    backdrop: 'sea',
    lanes: 3,
    rails: false,
    density: 0.44,
    roadside: [r('palm', 5, 1.15, 2.2), r('palmTall', 4, 1.2, 2.4), r('palmBend', 3, 1.15, 2.0), r('bush', 2, 1.1, 1.6, { scale: 1.3 }), r('lightpost', 2, 1.1, 1.2)],
    landmarks: ['motel', 'signCoast', 'diner', 'billboardLow', 'gas', 'arch'],
    landmarkEvery: 46,
  }),
  cliffs: scene('cliffs', 'Cliff road', 'Coastal', 'Two lanes with oncoming traffic, banked sweepers, rock and gorse.', {
    palette: 'cliffs',
    backdrop: 'sea',
    lanes: 2,
    rails: true,
    bank: 0.45,
    oncoming: 0.25,
    density: 0.3,
    roadside: [r('rockTall', 4, 1.2, 2.0), r('rock', 4, 1.2, 2.4), r('bushLarge', 3, 1.12, 1.9), r('pineRound', 2, 1.3, 2.6), r('flower', 2, 1.08, 1.5, { collide: false, scale: 1.6 })],
    landmarks: ['signCoast', 'lightpost', 'billboardLow', 'gas'],
    landmarkEvery: 90,
  }),
  causeway: scene('causeway', 'Causeway', 'Coastal', 'Four lanes on a bridge deck, lamp posts, water on both sides.', {
    palette: 'coast',
    backdrop: 'sea',
    lanes: 4,
    rails: true,
    density: 0.22,
    roadside: [r('lightpostTall', 6, 1.1, 1.18), r('banner', 1, 1.3, 1.5)],
    landmarks: ['signCoast', 'arch', 'tower'],
    landmarkEvery: 70,
  }),
  plains: scene('plains', 'Farm fields', 'Country', 'Two lanes across the fields, oncoming traffic, crossroads.', {
    palette: 'plains',
    backdrop: 'hills',
    lanes: 2,
    rails: false,
    oncoming: 0.4,
    crossings: true,
    density: 0.16,
    roadside: [r('oak', 3, 1.4, 2.8), r('tree', 3, 1.4, 2.8), r('bush', 3, 1.12, 1.8, { scale: 1.2 }), r('stump', 1, 1.15, 1.8)],
    landmarks: ['gas', 'billboardLow', 'diner', 'signDrive', 'motel'],
    landmarkEvery: 110,
  }),
  forest: scene('forest', 'Pine forest', 'Country', 'Narrow, walled in by pines, a little banking, oncoming traffic.', {
    palette: 'forest',
    backdrop: 'hills',
    lanes: 2,
    rails: true,
    oncoming: 0.3,
    bank: 0.3,
    density: 0.38,
    roadside: [r('pine', 5, 1.15, 2.3), r('pineRound', 3, 1.25, 2.6), r('oak', 3, 1.3, 2.8), r('bushLarge', 2, 1.15, 1.9), r('stump', 1, 1.15, 1.8)],
    landmarks: ['motel', 'billboard', 'signDrive', 'lightpost'],
    landmarkEvery: 100,
  }),
  ridge: scene('ridge', 'Blue ridge', 'Country', 'Rolling hardwood ridge: banked curves and broadleaf trees.', {
    palette: 'ridge',
    backdrop: 'hills',
    lanes: 2,
    rails: true,
    bank: 0.7,
    oncoming: 0.35,
    density: 0.4,
    roadside: [r('oak', 4, 1.2, 2.6), r('tree', 4, 1.2, 2.6), r('pineRound', 3, 1.25, 2.6), r('bushLarge', 2, 1.12, 1.9), r('rock', 1, 1.3, 2.4)],
    landmarks: ['signDrive', 'billboard', 'motel', 'gas'],
    landmarkEvery: 95,
  }),
  suburb: scene('suburb', 'Suburbs', 'Country', 'Three lanes through the outskirts: lawns, street lamps, gas stations.', {
    palette: 'suburb',
    backdrop: 'city',
    lanes: 3,
    rails: false,
    crossings: true,
    density: 0.34,
    roadside: [r('tree', 4, 1.3, 2.2), r('oak', 3, 1.35, 2.4), r('bushLarge', 3, 1.14, 1.7), r('lightpost', 3, 1.1, 1.16), r('flower', 2, 1.06, 1.4, { collide: false, scale: 1.6 })],
    landmarks: ['gas', 'diner', 'motel', 'billboardLow', 'signDrive'],
    landmarkEvery: 64,
  }),
  canyon: scene('canyon', 'Red canyon', 'Arid', 'Two lanes cut through the rock, hard banking, no rail at all.', {
    palette: 'canyon',
    backdrop: 'mesas',
    lanes: 2,
    rails: false,
    bank: 0.8,
    oncoming: 0.35,
    density: 0.24,
    roadside: [r('rockTall', 4, 1.25, 2.1), r('rock', 4, 1.25, 2.6), r('cactus', 4, 1.2, 2.2), r('cactusTall', 2, 1.3, 2.4)],
    landmarks: ['gas', 'billboardLow', 'signDrive', 'arch'],
    landmarkEvery: 80,
  }),
  desert: scene('desert', 'Salt flats', 'Arid', 'Four lanes, dead flat, almost nothing beside the road. Fastest scene there is.', {
    palette: 'desert',
    backdrop: 'dunes',
    lanes: 4,
    rails: false,
    crossings: true,
    density: 0.14,
    roadside: [r('cactus', 4, 1.2, 2.6), r('cactusTall', 3, 1.3, 2.6), r('rock', 2, 1.3, 2.8), r('stoneTall', 1, 1.4, 2.8)],
    landmarks: ['gas', 'billboardLow', 'diner', 'signDrive'],
    landmarkEvery: 120,
  }),
  alpine: scene('alpine', 'High pass', 'Mountain', 'Two lanes above the treeline, guardrail, long banked sweepers.', {
    palette: 'alpine',
    backdrop: 'peaks',
    lanes: 2,
    rails: true,
    bank: 0.6,
    oncoming: 0.3,
    density: 0.34,
    roadside: [r('pineTall', 5, 1.15, 2.3), r('pine', 3, 1.2, 2.5), r('rockTall', 2, 1.3, 2.4)],
    landmarks: ['signDrive', 'arch', 'billboard', 'lightpost'],
    landmarkEvery: 90,
  }),
  city: scene('city', 'Downtown', 'Urban', 'Four lanes between shopfronts, crossroads, roadworks. Neon at night.', {
    palette: 'city',
    backdrop: 'city',
    lanes: 4,
    rails: false,
    crossings: true,
    workZones: true,
    density: 1.0,
    roadside: [r('facade1', 5, 1.52, 1.56), r('facade2', 5, 1.52, 1.56), r('facade3', 4, 1.5, 1.55), r('facade4', 4, 1.5, 1.55), r('block', 3, 2.7, 2.9), r('tower2', 2, 2.8, 3.1), r('lightpost', 2, 1.1, 1.16, { collide: true })],
    landmarks: ['gas', 'diner', 'signBay', 'arch', 'motel'],
    landmarkEvery: 70,
  }),
  neonCity: scene('neonCity', 'Neon blocks', 'Urban', 'The lit-facade downtown: pink and cyan shopfronts, towers behind.', {
    palette: 'city',
    backdrop: 'city',
    lanes: 4,
    rails: false,
    crossings: true,
    workZones: true,
    density: 1.0,
    roadside: [r('facadeLit1', 6, 1.52, 1.56), r('facadeLit2', 6, 1.5, 1.55), r('facade3', 2, 1.5, 1.55), r('tower', 3, 2.7, 3.0), r('tower2', 3, 2.7, 3.0), r('lightpostTall', 3, 1.1, 1.16, { collide: true })],
    landmarks: ['signBay', 'arch', 'diner', 'motel'],
    landmarkEvery: 60,
  }),
  boulevard: scene('boulevard', 'Lit boulevard', 'Urban', 'Four lanes with a rail, tall lamps and towers set back — the bridge run into the city.', {
    palette: 'city',
    backdrop: 'city',
    lanes: 4,
    rails: true,
    workZones: true,
    density: 0.3,
    roadside: [r('lightpostTall', 4, 1.15, 1.3), r('tree', 2, 1.5, 2.6), r('banner', 1, 1.4, 2.0)],
    landmarks: ['tower', 'signBay', 'tower2', 'diner', 'arch', 'grandstand', 'motel', 'tower'],
    landmarkEvery: 45,
  }),
  industrial: scene('industrial', 'Docks', 'Urban', 'Four lanes past warehouses and cranes: blocks, towers, roadworks.', {
    palette: 'industrial',
    backdrop: 'city',
    lanes: 4,
    rails: true,
    crossings: true,
    workZones: true,
    density: 0.5,
    roadside: [r('block', 5, 1.7, 2.2), r('block2', 4, 1.8, 2.4), r('tower2', 2, 2.6, 3.0), r('lightpostTall', 4, 1.1, 1.18, { collide: true }), r('barrier', 2, 1.15, 1.3)],
    landmarks: ['gas', 'signBay', 'grandstand', 'pitsOffice', 'tent'],
    landmarkEvery: 80,
  }),
}

export const SCENE_IDS: string[] = Object.keys(SCENES)

export function sceneDef(id: string): SceneDef {
  return SCENES[id] ?? SCENES.coast
}

/** Scene ids grouped for the editor palette, in the order the groups should be shown. */
export function sceneGroups(): { group: string; scenes: SceneDef[] }[] {
  const order: SceneDef['group'][] = ['Coastal', 'Country', 'Arid', 'Mountain', 'Urban']
  return order.map((group) => ({ group, scenes: SCENE_IDS.map(sceneDef).filter((s) => s.group === group) }))
}

/**
 * Props you can drop by hand, grouped. Everything here is already in the sprite
 * manifest (src/render/models.ts), so placing one costs nothing at bake time.
 */
export const PROP_GROUPS: { group: string; kinds: { kind: string; name: string; scale?: number; offset?: number }[] }[] = [
  {
    group: 'Trees',
    kinds: [
      { kind: 'palm', name: 'Palm' },
      { kind: 'palmTall', name: 'Tall palm' },
      { kind: 'palmBend', name: 'Bent palm' },
      { kind: 'pine', name: 'Pine' },
      { kind: 'pineTall', name: 'Tall pine' },
      { kind: 'pineRound', name: 'Round pine' },
      { kind: 'oak', name: 'Oak' },
      { kind: 'tree', name: 'Tree' },
      { kind: 'stump', name: 'Stump' },
    ],
  },
  {
    group: 'Ground',
    kinds: [
      { kind: 'bush', name: 'Bush', scale: 1.3 },
      { kind: 'bushLarge', name: 'Big bush' },
      { kind: 'rock', name: 'Rock' },
      { kind: 'rockTall', name: 'Tall rock' },
      { kind: 'stoneTall', name: 'Standing stone' },
      { kind: 'cactus', name: 'Cactus' },
      { kind: 'cactusTall', name: 'Tall cactus' },
      { kind: 'flower', name: 'Flowers', scale: 1.6 },
    ],
  },
  {
    group: 'Buildings',
    kinds: [
      { kind: 'diner', name: 'Diner', offset: 1.9 },
      { kind: 'motel', name: 'Motel', offset: 2.1 },
      { kind: 'gas', name: 'Gas station', offset: 2.0 },
      { kind: 'facade1', name: 'Shopfront A', offset: 1.54 },
      { kind: 'facade2', name: 'Shopfront B', offset: 1.54 },
      { kind: 'facade3', name: 'Shopfront C', offset: 1.52 },
      { kind: 'facade4', name: 'Shopfront D', offset: 1.52 },
      { kind: 'facadeLit1', name: 'Neon front A', offset: 1.54 },
      { kind: 'facadeLit2', name: 'Neon front B', offset: 1.52 },
      { kind: 'block', name: 'Block', offset: 2.8 },
      { kind: 'block2', name: 'Low block', offset: 2.6 },
      { kind: 'tower', name: 'Tower', offset: 2.9 },
      { kind: 'tower2', name: 'Small tower', offset: 2.9 },
      { kind: 'grandstand', name: 'Grandstand', offset: 2.2 },
      { kind: 'pitsOffice', name: 'Office', offset: 2.2 },
      { kind: 'tent', name: 'Tent', offset: 2.0 },
    ],
  },
  {
    group: 'Roadside',
    kinds: [
      { kind: 'barrier', name: 'Jersey barrier', offset: 0.98, scale: 0.8 },
      { kind: 'lightpost', name: 'Lamp post', offset: 1.14 },
      { kind: 'lightpostTall', name: 'Tall lamp', offset: 1.14 },
      { kind: 'billboard', name: 'Billboard', offset: 1.9 },
      { kind: 'billboardLow', name: 'Low billboard', offset: 1.9 },
      { kind: 'banner', name: 'Banner', offset: 1.5 },
      { kind: 'signCoast', name: 'Sign · COAST HWY', offset: 1.9 },
      { kind: 'signDrive', name: 'Sign · DRIVE SAFE', offset: 1.9 },
      { kind: 'signBay', name: 'Sign · NEON BAY', offset: 1.9 },
      { kind: 'arch', name: 'Arch', offset: 0 },
      { kind: 'gantry', name: 'Start gantry', offset: 0 },
    ],
  },
]

export const PROP_INFO: Record<string, { name: string; scale?: number; offset?: number }> = Object.fromEntries(PROP_GROUPS.flatMap((g) => g.kinds.map((k) => [k.kind, k])))
