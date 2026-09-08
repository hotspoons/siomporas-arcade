// Sprite manifest: which CC0 model renders which sprite kind, how tall it is
// in metres, and from which yaw angles (degrees; 0 = seen from behind).

import type { Object3D } from 'three'
import { buildArch, buildBlock, buildDiner, buildFacade, buildGasStation, buildMotel, buildPrototype, buildSign, buildTower, LIVERIES } from './procgen'

export interface ModelDef {
  kind: string
  /** GLB path, or empty when `build` supplies the model. */
  file: string
  build?: () => Object3D
  heightM: number
  /** Yaw angles to bake; sprites pick the nearest. */
  yaws: number[]
  /** Camera pitch angles to bake (degrees above the horizontal); default one, slightly from above. */
  pitches?: number[]
  /** Cell size in the atlas. */
  cell: number
  /** Extra uniform scale on the model before fitting (some kits are tiny). */
  fit?: number
}

/**
 * Smallest square texture the shelf packer fits the whole manifest into, mirroring
 * SpriteAtlas' order (big cells first). Adding views to a model grows the atlas instead
 * of silently overflowing it.
 */
export function atlasSizeFor(defs: ModelDef[]): number {
  const cells = defs.flatMap((d) => d.yaws.flatMap(() => (d.pitches ?? [0]).map(() => d.cell))).sort((a, b) => b - a)
  for (const size of [1024, 2048, 4096, 8192]) {
    let x = 0
    let y = 0
    let h = 0
    let fits = true
    for (const c of cells) {
      if (x + c > size) {
        x = 0
        y += h
        h = 0
      }
      if (y + c > size) {
        fits = false
        break
      }
      x += c
      h = Math.max(h, c)
    }
    if (fits) return size
  }
  return 8192
}

/** Hero views: fine steps for steering, coarse ones all the way round for the crash spin. */
export const HERO_YAWS = [0, 12, 24, 38, 60, 90, 120, 150, 180, -12, -24, -38, -60, -90, -120, -150]
const N = (kind: string, file: string, heightM: number, cell = 128): ModelDef => ({ kind, file: `assets/nature/${file}.glb`, heightM, yaws: [0], cell })
const P = (kind: string, file: string, heightM: number, cell = 128): ModelDef => ({ kind, file: `assets/props/${file}.glb`, heightM, yaws: [0], cell })
/** Traffic: fine flank steps for cars near your lane, quarter views for crossers, head-on, and four pitches for hills. */
export const TRAFFIC_YAWS = [0, 6, 13, 22, 35, 90, 180, -6, -13, -22, -35, -90]
export const TRAFFIC_PITCHES = [-5, 4, 13, 22]
const C = (kind: string, file: string): ModelDef => ({ kind, file: `assets/cars/${file}.glb`, heightM: 1.5, yaws: TRAFFIC_YAWS, pitches: TRAFFIC_PITCHES, cell: 128 })

export const MODELS: ModelDef[] = [
  N('palm', 'tree_palm', 10, 192),
  N('palmTall', 'tree_palmTall', 13, 192),
  N('palmBend', 'tree_palmBend', 9.5, 192),
  N('pine', 'tree_pineDefaultA', 9, 192),
  N('pineTall', 'tree_pineTallA', 13, 192),
  N('pineRound', 'tree_pineRoundA', 8, 192),
  N('oak', 'tree_oak', 9, 192),
  N('tree', 'tree_default', 8, 192),
  N('bush', 'plant_bush', 1.6, 96),
  N('bushLarge', 'plant_bushLarge', 2.4, 96),
  N('rock', 'rock_largeA', 2.6, 96),
  N('rockTall', 'rock_tallA', 4.2, 128),
  N('stoneTall', 'stone_tallA', 3.5, 128),
  N('cactus', 'cactus_short', 2.4, 96),
  N('cactusTall', 'cactus_tall', 4.0, 128),
  N('flower', 'flower_redA', 0.8, 64),
  N('stump', 'stump_old', 1.0, 64),
  P('billboard', 'billboard', 7.5, 256),
  P('billboardLow', 'billboardLow', 5.5, 256),
  P('lightpost', 'lightPostModern', 8, 128),
  P('lightpostTall', 'lightPostLarge', 10, 128),
  P('barrier', 'barrierWall', 1.2, 96),
  P('banner', 'bannerTowerRed', 6, 128),
  P('grandstand', 'grandStand', 7, 256),
  P('tent', 'tent', 4, 192),
  P('pitsOffice', 'pitsOffice', 6, 256),
  P('gantry', 'overheadLights', 8.5, 256),
  // Hero prototypes, one per livery; the chase view picks the selected one.
  ...Object.entries(LIVERIES).map(([id, l]): ModelDef => ({ kind: `hero_${id}`, file: '', build: () => buildPrototype(l), heightM: 1.1, yaws: HERO_YAWS, cell: 288 })),
  { kind: 'formula', file: 'assets/cars/race.glb', heightM: 1.1, yaws: HERO_YAWS, cell: 288 },
  // Roadside architecture and signage.
  { kind: 'diner', file: '', build: buildDiner, heightM: 6.4, yaws: [0], cell: 256 },
  { kind: 'block', file: '', build: () => buildBlock(15, 14, 0x9aa4ae), heightM: 15, yaws: [0], cell: 192 },
  { kind: 'facade1', file: '', build: () => buildFacade(8, 3, 0xc8b8a0, 0xb03a3a, false), heightM: 14.4, yaws: [0], cell: 192 },
  { kind: 'facade2', file: '', build: () => buildFacade(7, 4, 0x9aa6b4, 0x2a6a9a, false), heightM: 17.8, yaws: [0], cell: 192 },
  { kind: 'facade3', file: '', build: () => buildFacade(8.5, 2, 0xd8c0a8, 0x3a8a4a, false), heightM: 11, yaws: [0], cell: 160 },
  { kind: 'facade4', file: '', build: () => buildFacade(7.5, 5, 0xb8a090, 0xc08a2a, false), heightM: 21.2, yaws: [0], cell: 224 },
  { kind: 'facadeLit1', file: '', build: () => buildFacade(8, 4, 0x4a4a5a, 0xff5fd2, true), heightM: 17.8, yaws: [0], cell: 192 },
  { kind: 'facadeLit2', file: '', build: () => buildFacade(7, 3, 0x3a3e4e, 0x25e8ff, true), heightM: 14.4, yaws: [0], cell: 192 },
  { kind: 'block2', file: '', build: () => buildBlock(11, 12, 0xb08a70), heightM: 11, yaws: [0], cell: 192 },
  { kind: 'motel', file: '', build: buildMotel, heightM: 7.6, yaws: [0], cell: 256 },
  { kind: 'gas', file: '', build: buildGasStation, heightM: 4.6, yaws: [0], cell: 256 },
  { kind: 'tower', file: '', build: () => buildTower(34, 0x3a4a6a), heightM: 37, yaws: [0], cell: 256 },
  { kind: 'tower2', file: '', build: () => buildTower(22, 0x5a4a5a), heightM: 25, yaws: [0], cell: 256 },
  { kind: 'signCoast', file: '', build: () => buildSign('COAST HWY 1', '#ffffff', '#1a5a2a'), heightM: 7.3, yaws: [0], cell: 192 },
  { kind: 'signDrive', file: '', build: () => buildSign('DRIVE SAFE', '#ffe28a', '#7a1a1a'), heightM: 7.3, yaws: [0], cell: 192 },
  { kind: 'signBay', file: '', build: () => buildSign('NEON BAY 12', '#ff5fd2', '#101030'), heightM: 7.3, yaws: [0], cell: 192 },
  { kind: 'arch', file: '', build: buildArch, heightM: 10.2, yaws: [0], cell: 256 },
  C('sedan', 'sedan'),
  C('sedanSports', 'sedan-sports'),
  C('suv', 'suv'),
  C('van', 'van'),
  C('truck', 'truck'),
  C('taxi', 'taxi'),
  C('police', 'police'),
  C('delivery', 'delivery'),
]

/** Width in road-halves is derived from the baked aspect; these are height metres for the sim's hit tests elsewhere. */
export const MODEL_BY_KIND: Record<string, ModelDef> = Object.fromEntries(MODELS.map((m) => [m.kind, m]))

/** Atlas texture size for the current manifest (see atlasSizeFor). */
export const ATLAS_SIZE = atlasSizeFor(MODELS)
