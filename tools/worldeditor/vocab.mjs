// The words a level and a program may use, in one place an agent can ask.
//
// Rich, 2026-09-30, after a level was authored blind: nothing over MCP said which weather names
// exist, which seasons, which engine sounds a vehicle build may name, or which HUD parts and
// settings a program may switch off. Each list here is a COPY of the engine's own (weather.ts,
// season.ts, points.ts, gamepolicy.ts, program.ts) — the service has no bundler to import them
// through — and vocab.test.mjs holds every copy against its source, which is the only thing wrong
// with a copy.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODES, PROFILES } from './levels.mjs'
import { builtinFacades } from './facades.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** the engine-sound catalog, committed with the wasm it belongs to */
const ENGINES = path.resolve(HERE, '../../packages/enginesim/wasm/engines.json')
/** the sampled effects bank, written by tools/sounds/build.py; its slots are what a document's `sounds` may name */
const SOUND_BANK = path.resolve(HERE, '../../apps/corridor/public/sounds/bank.json')

export const WEATHERS = ['clear', 'rain', 'sleet', 'snow', 'ice']
export const SEASONS = ['winter', 'spring', 'summer', 'autumn']
export const POINT_KINDS = ['home', 'start', 'finish', 'checkpoint', 'spot']
export const POINT_MODES = ['drive', 'walk', 'fly']
export const HIDEABLE = ['street-names', 'minimap', 'hud', 'traffic', 'signals', 'buildings']
export const TRANSPORT = ['drive', 'walk', 'walk-third', 'fly', 'helicopter', 'omnicopter', 'ornithopter', 'plane', 'jet', 'ufo']
export const HUD_PARTS = ['speed', 'gear', 'heading', 'road', 'elevation', 'objectives', 'waypoint']
export const FREEDOMS = ['developer', 'teleport', 'transport']
export const SETTING_TABS = ['display', 'layers', 'audio', 'controls', 'site', 'game']
export const SETTING_CONTROLS = [
  'display.season', 'display.style', 'display.relief', 'display.trees', 'display.weather', 'display.perf', 'display.aa', 'display.detail', 'display.theme', 'display.interface', 'display.units',
  'layers.imagery', 'layers.horizon', 'layers.canopy', 'layers.trees', 'layers.splats', 'layers.grass', 'layers.rocks', 'layers.water',
  'layers.road', 'layers.structures', 'layers.barriers', 'layers.sidewalks', 'layers.parking',
  'layers.buildings', 'layers.power', 'layers.furniture', 'layers.signals', 'layers.stopbars', 'layers.blades',
  'layers.spine', 'layers.markers', 'layers.wire',
  'audio.master', 'audio.engine', 'audio.sfx', 'audio.mute',
  'controls.bindings', 'controls.gamepad', 'controls.haptics', 'controls.recover', 'controls.reset', 'controls.map',
  'game.tuning', 'game.developer', 'game.restart', 'game.levels', 'game.transport', 'game.physics',
]
/** what a vehicle build's `spec.drive` may be */
export const DRIVES = ['fwd', 'rwd', 'awd']
/** the building classes a footprint is drawn as (src/world/facades.ts FACADE_CLASS_IDS) */
export const BUILDING_CLASSES = ['house', 'townhouse', 'apartments', 'commercial', 'skyscraper', 'industrial', 'civic', 'farm', 'shed']
/** the vehicle template kinds vehicle_template takes */
export const VEHICLE_KINDS = ['hero-car', 'traffic', 'van', 'truck', 'bus']

/** every engine-sound setup a build's `audio.setup` may name, with its group and name */
export async function engineSounds() {
  try {
    const list = JSON.parse(await readFile(ENGINES, 'utf8'))
    return list.map((e) => ({ setup: e.path, group: e.group, name: e.name }))
  } catch {
    return []
  }
}

/**
 * Every sound slot a vehicle's or actor's `sounds` may override, with what it is for and the
 * bank's own clips (which an override may also name, as `<folder>/<clip>`).
 */
export async function soundSlots() {
  try {
    const bank = JSON.parse(await readFile(SOUND_BANK, 'utf8'))
    return Object.entries(bank.slots).map(([slot, s]) => ({ slot, desc: s.desc, loop: !!s.loop, clips: s.clips.map((c) => c.file.replace(/\.ogg$/, '')) }))
  } catch {
    return []
  }
}

/** the whole vocabulary, as `level_vocab` answers */
export async function vocab() {
  const engines = await engineSounds()
  const sounds = await soundSlots()
  const facades = await builtinFacades().catch(() => [])
  return {
    level: {
      keys: 'see level_validate — a key outside its list is warned about',
      weather: WEATHERS,
      season: SEASONS,
      mode: MODES,
      profile: PROFILES,
      time: 'HH:MM, local to the site',
      physics: 'not a key: a level with a traffic simulation runs physics, and its player drives the physics car',
    },
    points: { kind: POINT_KINDS, mode: POINT_MODES },
    vehicle: { kinds: VEHICLE_KINDS, drive: DRIVES, audio_setup: engines.map((e) => e.setup), engines },
    sounds: {
      note: 'a vehicle or actor document may carry `sounds: { <slot>: [clips] }`; a clip is a bank clip below, `slot:<other slot>`, `asset:<id>/<file>` (PUT /assetsvc/catalog/<id>/sound/<file>) or a URL. An empty list is silence. Programs: api.audio.play(slot, { at, gain, rate }), api.audio.override(slot, clips)',
      slots: sounds,
    },
    buildings: {
      note: 'every footprint is one of these classes and draws one wall and one roof from its class\u2019s pools (building_class_list / building_class_set); metalness is its reflectiveness',
      classes: BUILDING_CLASSES.map((id) => {
        const c = facades.find((x) => x.id === id)
        return { id, label: c?.label ?? id, osm: c?.osm ?? [], ...(c?.min_height_m !== undefined ? { min_height_m: c.min_height_m } : {}) }
      }),
      fields: { walls: '[{ material, weight }]', roofs: '[{ material, weight }]', metalness: '0…1', roughness: '0…1', glass: 'boolean' },
    },
    program: {
      hideable: HIDEABLE,
      transport: TRANSPORT,
      hud_parts: HUD_PARTS,
      freedoms: FREEDOMS,
      setting_tabs: SETTING_TABS,
      setting_controls: SETTING_CONTROLS,
      weather: WEATHERS,
    },
    ...(engines.length ? {} : { warning: `no engine list at ${ENGINES} — the vehicle audio setups are unknown here` }),
  }
}
