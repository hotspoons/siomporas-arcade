// The editor sets the image generator's and TRELLIS's endpoints; the registry must then USE them.
// Asserting only that the setting was stored would pass on a service that saved the URL and kept
// calling the old one — so these build the registry and ask it where it would send a job.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildRegistry } from './adapters.mjs'
import { AssetSettings } from './settings.mjs'

const ROSTER = {
  defaults: { image: 'flux2-dev', mesh: 'trellis2' },
  models: {
    'flux2-dev': { kind: 'image', model: 'flux.2-dev', url: 'http://flux.from-file' },
    'flux2-klein': { kind: 'image', model: 'flux.2-klein', url: '' },
    trellis2: { kind: 'mesh', url: 'http://recon.from-file' },
  },
}
const fresh = (env = {}) => new AssetSettings(mkdtempSync(path.join(tmpdir(), 'asettings-')), env, ROSTER).load()
const urlOf = (s, kind) => {
  const r = buildRegistry(ROSTER, s.effectiveEnv())
  return r[kind].url
}

test('with nothing set, the roster file decides', async () => {
  const s = await fresh()
  assert.equal(urlOf(s, 'image'), 'http://flux.from-file')
  assert.equal(urlOf(s, 'mesh'), 'http://recon.from-file')
  assert.equal(s.source('url.trellis2'), 'default')
})

test('the environment beats the file, under the name it already had', async () => {
  const s = await fresh({ ASSETSVC_URL_TRELLIS2: 'http://recon.from-env' })
  assert.equal(urlOf(s, 'mesh'), 'http://recon.from-env')
  assert.equal(s.source('url.trellis2'), 'env')
})

test('a value from the editor beats the environment, AND the registry uses it', async () => {
  const s = await fresh({ ASSETSVC_URL_TRELLIS2: 'http://recon.from-env' })
  await s.set({ 'url.trellis2': 'http://recon.from-ui' })
  assert.equal(urlOf(s, 'mesh'), 'http://recon.from-ui')
  assert.equal(s.source('url.trellis2'), 'ui')
})

test('choosing a different image model changes which model the registry calls', async () => {
  const s = await fresh()
  await s.set({ 'image.model': 'flux2-klein', 'url.flux2-klein': 'http://klein.from-ui' })
  const r = buildRegistry(ROSTER, s.effectiveEnv())
  assert.equal(r.image.id, 'flux2-klein')
  assert.equal(r.image.url, 'http://klein.from-ui')
})

test('clearing falls back to the environment, not the file', async () => {
  const s = await fresh({ ASSETSVC_URL_FLUX2_DEV: 'http://flux.from-env' })
  await s.set({ 'url.flux2-dev': 'http://flux.from-ui' })
  await s.set({ 'url.flux2-dev': null })
  assert.equal(urlOf(s, 'image'), 'http://flux.from-env')
})

test('a model the roster does not have cannot be chosen', async () => {
  const s = await fresh()
  await assert.rejects(s.set({ 'image.model': 'dall-e' }), /must be one of flux2-dev, flux2-klein/)
  // and a mesh model is not an image model
  await assert.rejects(s.set({ 'image.model': 'trellis2' }), /must be one of/)
})

test('an invalid patch changes nothing', async () => {
  const s = await fresh()
  await assert.rejects(s.set({ 'url.trellis2': 'http://fine', 'url.flux2-dev': 'not a url' }), /not a URL/)
  assert.equal(urlOf(s, 'mesh'), 'http://recon.from-file', 'the valid half must not have been saved')
})

test('it survives a restart', async () => {
  const s = await fresh()
  await s.set({ 'url.trellis2': 'http://recon.saved' })
  const again = await new AssetSettings(path.dirname(s.file), {}, ROSTER).load()
  assert.equal(urlOf(again, 'mesh'), 'http://recon.saved')
})
