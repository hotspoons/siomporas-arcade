// Every list in vocab.mjs is a copy of one in the app. This holds each against its source, so a
// name added to the engine reaches the tool — the only thing wrong with a copy is drift.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as V from './vocab.mjs'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/corridor/src')
const read = (f) => readFileSync(path.join(SRC, f), 'utf8')
/** the string literals of `export const NAME = [...]` (or `: X[] = [...]`) */
function list(file, name) {
  const m = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(read(file))
  assert.ok(m, `${name} in ${file}`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}
/** the keys of `export const NAME = { 'a': ..., b: ... } as const` */
function keys(file, name) {
  const text = read(file)
  const start = text.indexOf(`export const ${name} = {`)
  assert.ok(start >= 0, `${name} in ${file}`)
  const end = text.indexOf('} as const', start)
  // a key is followed by a quoted description; several sit on one line in gamepolicy.ts
  return [...text.slice(start + name.length + 16, end).matchAll(/(?:^|[{,])\s*'?([a-z][a-z.-]*)'?:\s*["']/gm)].map((x) => x[1])
}

test('weather, season, transport, hideable, hud parts and point kinds match the app', () => {
  assert.deepEqual(V.WEATHERS, list('visuals/weather.ts', 'WEATHERS'))
  assert.deepEqual(V.SEASONS, list('visuals/season.ts', 'SEASONS'))
  assert.deepEqual(V.TRANSPORT, list('game/session/program.ts', 'TRANSPORT'))
  assert.deepEqual(V.POINT_KINDS, list('game/world/points.ts', 'POINT_KINDS'))
  assert.deepEqual(V.POINT_MODES, list('game/world/points.ts', 'POINT_MODES'))
  assert.deepEqual(V.HIDEABLE, keys('game/session/program.ts', 'HIDEABLE'))
  assert.deepEqual(V.HUD_PARTS, keys('game/session/gamepolicy.ts', 'HUD_PARTS'))
  assert.deepEqual(V.SETTING_TABS, keys('game/session/gamepolicy.ts', 'SETTING_TABS'))
  assert.deepEqual(V.SETTING_CONTROLS, keys('game/session/gamepolicy.ts', 'SETTING_CONTROLS'))
})

test('the engine-sound list is read from the catalog beside the wasm', async () => {
  const e = await V.engineSounds()
  assert.ok(e.length >= 20)
  assert.ok(e.every((x) => x.setup.startsWith('engines/') && x.setup.endsWith('.mr')))
})

test('the sound slots come from the bank the app ships, and the app plays every one of them', async () => {
  const slots = await V.soundSlots()
  assert.ok(slots.length >= 10, 'the bank manifest is present')
  const app = list('game/audio/soundbank.ts', 'SOUND_SLOTS')
  assert.deepEqual(slots.map((s) => s.slot).sort(), [...app].sort())
  for (const s of slots) {
    assert.ok(s.desc && s.clips.length, `${s.slot} has a description and clips`)
    for (const c of s.clips) assert.match(c, /^[a-z0-9-]+\/[A-Za-z0-9_.-]+$/)
  }
  const v = await V.vocab()
  assert.equal(v.sounds.slots.length, slots.length)
})

test('the building classes match the app’s list and its built-in set', async () => {
  assert.deepEqual(V.BUILDING_CLASSES, list('world/facades.ts', 'FACADE_CLASS_IDS'))
  const shipped = JSON.parse(read('world/facades.json')).classes.map((c) => c.id)
  assert.deepEqual(V.BUILDING_CLASSES, shipped)
  const v = await V.vocab()
  assert.deepEqual(v.buildings.classes.map((c) => c.id), V.BUILDING_CLASSES)
  assert.ok(v.buildings.classes.find((c) => c.id === 'skyscraper').min_height_m >= 30, 'the tower rule is a height')
})
