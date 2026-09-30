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
  assert.deepEqual(V.WEATHERS, list('weather.ts', 'WEATHERS'))
  assert.deepEqual(V.SEASONS, list('season.ts', 'SEASONS'))
  assert.deepEqual(V.TRANSPORT, list('program.ts', 'TRANSPORT'))
  assert.deepEqual(V.POINT_KINDS, list('points.ts', 'POINT_KINDS'))
  assert.deepEqual(V.POINT_MODES, list('points.ts', 'POINT_MODES'))
  assert.deepEqual(V.HIDEABLE, keys('program.ts', 'HIDEABLE'))
  assert.deepEqual(V.HUD_PARTS, keys('gamepolicy.ts', 'HUD_PARTS'))
  assert.deepEqual(V.SETTING_TABS, keys('gamepolicy.ts', 'SETTING_TABS'))
  assert.deepEqual(V.SETTING_CONTROLS, keys('gamepolicy.ts', 'SETTING_CONTROLS'))
})

test('the engine-sound list is read from the catalog beside the wasm', async () => {
  const e = await V.engineSounds()
  assert.ok(e.length >= 20)
  assert.ok(e.every((x) => x.setup.startsWith('engines/') && x.setup.endsWith('.mr')))
})
