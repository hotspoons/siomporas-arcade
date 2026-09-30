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

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** the engine-sound catalog, committed with the wasm it belongs to */
const ENGINES = path.resolve(HERE, '../../packages/enginesim/wasm/engines.json')

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
  'display.season', 'display.style', 'display.relief', 'display.trees', 'display.weather', 'display.perf', 'display.aa', 'display.theme', 'display.interface', 'display.units',
  'layers.imagery', 'layers.horizon', 'layers.canopy', 'layers.trees', 'layers.splats', 'layers.grass', 'layers.rocks', 'layers.water',
  'layers.road', 'layers.structures', 'layers.barriers', 'layers.sidewalks', 'layers.parking',
  'layers.buildings', 'layers.power', 'layers.furniture', 'layers.signals', 'layers.stopbars', 'layers.blades',
  'layers.spine', 'layers.markers', 'layers.wire',
  'audio.master', 'audio.engine', 'audio.sfx', 'audio.mute',
  'controls.bindings', 'controls.gamepad', 'controls.haptics', 'controls.recover', 'controls.reset',
  'game.tuning', 'game.developer', 'game.restart', 'game.transport',
]
/** what a vehicle build's `spec.drive` may be */
export const DRIVES = ['fwd', 'rwd', 'awd']
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

/** the whole vocabulary, as `level_vocab` answers */
export async function vocab() {
  const engines = await engineSounds()
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
