// The order a setting resolves in is the contract: a UI value, then the environment, then a
// default — and clearing a UI value must land on the environment, never on the default, or
// "reset" silently discards what the deployment said.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Settings, SCHEMA } from './settings.mjs'

const fresh = (env = {}) => new Settings(mkdtempSync(path.join(tmpdir(), 'settings-')), env).load()

test('the default, when nothing says otherwise, and it says it is a default', async () => {
  const s = await fresh()
  assert.equal(s.get('splat.runner'), 'auto')
  assert.equal(s.source('splat.runner'), 'default')
})

test('the environment beats the default', async () => {
  const s = await fresh({ WORLDEDITOR_ASSETSVC: 'http://assetsvc.default.svc' })
  assert.equal(s.get('assetsvc.url'), 'http://assetsvc.default.svc')
  assert.equal(s.source('assetsvc.url'), 'env')
})

test('the UI beats the environment, and is kept on the volume', async () => {
  const s = await fresh({ WORLDEDITOR_ASSETSVC: 'http://from-env' })
  await s.set({ 'assetsvc.url': 'http://from-ui' })
  assert.equal(s.get('assetsvc.url'), 'http://from-ui')
  assert.equal(s.source('assetsvc.url'), 'ui')
  // and a new process reading the same volume sees it
  const again = await new Settings(path.dirname(s.file), { WORLDEDITOR_ASSETSVC: 'http://from-env' }).load()
  assert.equal(again.get('assetsvc.url'), 'http://from-ui')
})

test('CLEARING a UI value falls back to the ENVIRONMENT, not to the default', async () => {
  // The failure this pins: a reset that jumps past the deployment's own value to the built-in
  // default would silently point the editor at nothing while the chart plainly said somewhere.
  const s = await fresh({ WORLDEDITOR_ASSETSVC: 'http://from-env' })
  await s.set({ 'assetsvc.url': 'http://from-ui' })
  await s.set({ 'assetsvc.url': null })
  assert.equal(s.get('assetsvc.url'), 'http://from-env')
  assert.equal(s.source('assetsvc.url'), 'env')
})

test('the environment is never written to the file', async () => {
  const s = await fresh({ WORLDEDITOR_SPLAT_IMAGE: 'ghcr.io/x/y:1' })
  await s.set({ 'splat.runner': 'jobset' })
  const doc = JSON.parse(readFileSync(s.file, 'utf8'))
  assert.deepEqual(Object.keys(doc.values), ['splat.runner'])
})

test('an invalid value refuses the WHOLE patch', async () => {
  // half a configuration change is harder to reason about than none
  const s = await fresh()
  await assert.rejects(
    s.set({ 'splat.runner': 'jobset', 'assetsvc.url': 'not a url' }),
    /is not a URL/,
  )
  assert.equal(s.get('splat.runner'), 'auto', 'the valid half must not have been saved either')
})

test('each kind is validated for what it is', async () => {
  const s = await fresh()
  await assert.rejects(s.set({ 'splat.runner': 'kubeflow' }), /must be one of auto, training, jobset, batch/)
  await assert.rejects(s.set({ 'splat.command': '{"not":"an array"}' }), /must be a JSON array/)
  await assert.rejects(s.set({ 'splat.command': '["unterminated' }), /not valid JSON/)
  await assert.rejects(s.set({ 'blender.autostart': 'yes' }), /true or false/)
  await assert.rejects(s.set({ 'nominatim.url': 'ftp://nope' }), /http or https/)
})

test('an unknown key is refused rather than stored', async () => {
  const s = await fresh()
  await assert.rejects(s.set({ 'aws.secret': 'x' }), /no setting "aws.secret"/)
})

test('listeners hear exactly the keys whose EFFECTIVE value changed', async () => {
  const s = await fresh({ WORLDEDITOR_ASSETSVC: 'http://same' })
  const heard = []
  s.onChange((keys) => heard.push(keys))
  // setting the UI value to what the env already says changes nothing a consumer would see
  await s.set({ 'assetsvc.url': 'http://same' })
  await s.set({ 'splat.runner': 'batch' })
  assert.deepEqual(heard, [[], ['splat.runner']])
})

test('describe() says where every value came from, and what a reset would land on', async () => {
  const s = await fresh({ WORLDEDITOR_ASSETSVC: 'http://from-env' })
  await s.set({ 'assetsvc.url': 'http://from-ui' })
  const row = s.describe().find((r) => r.key === 'assetsvc.url')
  assert.equal(row.source, 'ui')
  assert.equal(row.fallback, 'http://from-env')
  assert.equal(s.describe().length, SCHEMA.length)
})

test('value() parses the kinds that are not strings', async () => {
  const s = await fresh()
  assert.deepEqual(s.value('splat.command'), ['splatpipe'])
  assert.equal(s.value('blender.autostart'), false)
  await s.set({ 'blender.autostart': 'true' })
  assert.equal(s.value('blender.autostart'), true)
})
