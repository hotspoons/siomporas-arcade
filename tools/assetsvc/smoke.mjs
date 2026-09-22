#!/usr/bin/env node
// The whole loop, end to end, with numbers — against a running assetsvc.
//
// This is the test that matters for this service, because everything interesting about it is an
// integration: an adapter that speaks the wrong dialect, a model that is up but not ready, a
// finisher whose import closure is incomplete. None of that shows up in a unit test, and all of it
// shows up here in about a minute.
//
//   node tools/assetsvc/smoke.mjs [--url http://localhost:8770] [--keep] [--no-mesh]
//
// `--no-mesh` stops after the 2D step, which costs ten seconds instead of a GPU-minute and still
// exercises the adapter, the catalog, the job queue and the file route. `--keep` leaves the item
// behind so you can look at it in the editor.
import { Buffer } from 'node:buffer'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
const has = (n) => argv.includes(`--${n}`)

const URL_BASE = (flag('url', process.env.ASSETSVC ?? 'http://localhost:8770')).replace(/\/$/, '')
const ID = flag('id', 'smoke-test-cone')

let failures = 0
const ok = (label, detail = '') => console.log(`  ok    ${label.padEnd(34)} ${detail}`)
const bad = (label, detail = '') => {
  failures++
  console.log(`  FAIL  ${label.padEnd(34)} ${detail}`)
}

async function call(path, init) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  const text = await res.text()
  let body = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${path}: non-JSON ${res.status} ${text.slice(0, 160)}`)
  }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${body.error ?? ''}`)
  return body
}

async function waitFor(job, label) {
  const started = Date.now()
  for (;;) {
    const j = await call(`/jobs/${job}`)
    if (j.state === 'failed') throw new Error(`${label} failed: ${j.detail}`)
    if (j.state === 'done') return { ...j, wall: (Date.now() - started) / 1000 }
    process.stdout.write(`\r  …     ${label.padEnd(34)} ${j.state}${j.progress?.state ? ` (${j.progress.state})` : ''}   `)
    await new Promise((r) => setTimeout(r, 2000))
  }
}

console.log(`assetsvc smoke — ${URL_BASE}\n`)

// 1 · is anyone home, and what can they reach
try {
  await call('/health')
  ok('health')
} catch (e) {
  bad('health', String(e.message))
  console.log('\n  nothing else can run. Is the service up?')
  process.exit(1)
}

const models = await call('/models')
for (const m of models.models) {
  const live = models.reachable[m.id]
  if (!m.configured) ok(`model ${m.id}`, 'not configured (fine)')
  else if (live?.ok) ok(`model ${m.id}`, live.detail ?? 'reachable')
  else bad(`model ${m.id}`, live?.detail ?? 'unreachable')
}
ok('s3', models.s3.configured ? `${models.s3.bucket}/${models.s3.prefix}` : 'not configured (fine)')

// 2 · the catalog round trip
await call('/catalog', {
  method: 'POST',
  body: JSON.stringify({
    id: ID,
    subject: 'an orange traffic cone',
    kind: 'prop',
    // Small in frame ON PURPOSE: flux.2-dev crops tall subjects whatever the prompt says, and a
    // cone is short enough that this one survives. See README, "Traps".
    prompt:
      'A single orange plastic traffic cone, three-quarter view, small in frame with generous empty space on all sides. About 0.7 m tall with a square black rubber base and one white reflective band. Scuffed, slightly dusty. Even overcast light, no cast shadow, plain flat mid-grey background, no ground plane, no scenery, no text.',
    negative: 'scene, road, multiple cones, text, watermark, people, harsh shadow, cut off, cropped',
  }),
})
const created = await call(`/catalog/${ID}`)
created.state === 'spec' ? ok('catalog create', `state=${created.state}`) : bad('catalog create', `state=${created.state}`)

// 3 · the 2D step
const imgJob = await call(`/catalog/${ID}/image`, { method: 'POST', body: JSON.stringify({ size: '1024x1024', steps: 28, seed: 3 }) })
const img = await waitFor(imgJob.job, 'image')
process.stdout.write('\r')
ok('image', `${img.result.seconds.toFixed(1)}s via ${img.result.model}`)

const png = await fetch(`${URL_BASE}/catalog/${ID}/file/${img.result.file}`)
const pngBuf = Buffer.from(await png.arrayBuffer())
// A PNG that is served but is not a PNG is the failure a status code hides.
if (pngBuf.length > 1000 && pngBuf.slice(1, 4).toString() === 'PNG') ok('view served', `${(pngBuf.length / 1e6).toFixed(1)} MB`)
else bad('view served', `${pngBuf.length} bytes, magic ${JSON.stringify(pngBuf.slice(0, 8).toString('latin1'))}`)

// 4 · the 3D step
if (!has('no-mesh')) {
  const meshJob = await call(`/catalog/${ID}/mesh`, { method: 'POST', body: JSON.stringify({ seed: 1, finish: true }) })
  const mesh = await waitFor(meshJob.job, 'mesh')
  process.stdout.write('\r')
  const r = mesh.result
  ok('mesh', `${r.seconds.toFixed(1)}s via ${r.model}, ${(r.bytes / 1e6).toFixed(1)} MB, ${r.meta.vertices?.toLocaleString()} verts`)

  if (r.finished?.error) bad('finish', r.finished.error.slice(0, 120))
  else if (r.finished?.skipped) ok('finish', `skipped: ${r.finished.skipped}`)
  else ok('finish', r.finished?.bytes ? `${(r.finished.bytes / 1e3).toFixed(0)} kB from ${(r.finished.from / 1e6).toFixed(1)} MB` : 'done')

  // Read the glb back rather than trusting the byte count: this is where a broken finisher shows.
  const which = r.finished?.error ? 'mesh.glb' : 'mesh.finished.glb'
  const glbRes = await fetch(`${URL_BASE}/catalog/${ID}/file/${which}`)
  const glb = Buffer.from(await glbRes.arrayBuffer())
  if (glb.readUInt32LE(0) !== 0x46546c67) bad('glb served', `bad magic in ${which}`)
  else {
    const jsonLen = glb.readUInt32LE(12)
    const meta = JSON.parse(glb.slice(20, 20 + jsonLen).toString('utf8'))
    const ext = (meta.extensionsUsed ?? []).join(', ') || 'none'
    ok('glb served', `${which}, glTF ${glb.readUInt32LE(4)}, ${ext}`)
  }
}

// 5 · tidy up
if (!has('keep')) {
  await call(`/catalog/${ID}`, { method: 'DELETE' })
  ok('cleanup', `${ID} removed`)
} else {
  ok('cleanup', `kept ${ID} — look at it in the editor`)
}

console.log(failures ? `\n  ${failures} FAILED\n` : '\n  all good\n')
process.exit(failures ? 1 : 0)
