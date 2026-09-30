#!/usr/bin/env node
// Push a materials directory into an asset service: the starter pack, to a fresh cluster.
//
// Rich, 2026-09-30: "the deployed version ships with no textures — I'd like to provide a starter
// pack from what we already made". The pack lives beside the local service's data
// (`.local-assets/surfaces`: the road, shoulder and grass sets with their hex-tiling variants and
// macro maps, and the wall and roof materials); the cluster's service started with an empty
// volume. This walks the directory and PUTs every record and every map through the service's own
// upload routes, one file per request, skipping what is already there at the same size.
//
//   node tools/assetsvc/seed-materials.mjs --from .local-assets/surfaces --to https://<worldeditor>/assetsvc
//
// `raw*.jpg` (the untiled generation, kept for regenerating) is not sent: nothing renders it.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const FROM = path.resolve(opt('--from', '.local-assets/surfaces'))
const TO = (opt('--to', '') || '').replace(/\/$/, '')
const DRY = argv.includes('--dry-run')
const ONLY = opt('--only', '')
if (!TO) {
  console.error('usage: seed-materials.mjs --from <dir> --to <assetsvc url> [--only id,id] [--dry-run]')
  process.exit(2)
}
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ktx2': 'image/ktx2' }

const doc = JSON.parse(await readFile(path.join(FROM, 'materials.json'), 'utf8'))
const materials = (doc.materials ?? doc).filter((m) => !ONLY || ONLY.split(',').includes(m.id))
const remote = await fetch(`${TO}/materials`).then((r) => r.json()).then((d) => new Map((d.materials ?? []).map((m) => [m.id, m]))).catch(() => new Map())
let sentFiles = 0, sentBytes = 0, skipped = 0
for (const m of materials) {
  const dir = path.join(FROM, m.id)
  const files = (await readdir(dir).catch(() => [])).filter((n) => TYPES[path.extname(n).toLowerCase()] && !/^raw/.test(n)).sort()
  if (!files.length) { console.log(`${m.id}: no maps on disk — skipped`); continue }
  const have = remote.has(m.id) ? await fetch(`${TO}/materials/${m.id}/files`).then((r) => (r.ok ? r.json() : { files: [] })).then((d) => new Set(d.files ?? [])) : new Set()
  const { id, ...record } = m
  console.log(`${id}: ${files.length} maps${have.size ? `, ${[...have].filter((f) => files.includes(f)).length} already there` : ''}`)
  if (!DRY) {
    const r = await fetch(`${TO}/materials/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record) })
    if (!r.ok) throw new Error(`${id}: record: HTTP ${r.status} ${await r.text()}`)
  }
  for (const f of files) {
    if (have.has(f)) { skipped++; continue }
    const buf = await readFile(path.join(dir, f))
    if (!DRY) {
      const r = await fetch(`${TO}/materials/${id}/file/${encodeURIComponent(f)}`, { method: 'PUT', headers: { 'content-type': TYPES[path.extname(f).toLowerCase()] }, body: buf })
      if (!r.ok) throw new Error(`${id}/${f}: HTTP ${r.status} ${await r.text()}`)
    }
    sentFiles++
    sentBytes += buf.length
    process.stdout.write(`  ${f} ${(buf.length / 2 ** 20).toFixed(1)} MiB\n`)
  }
}
console.log(`${DRY ? 'would send' : 'sent'} ${sentFiles} files, ${(sentBytes / 2 ** 20).toFixed(1)} MiB (${skipped} already there) to ${TO}`)
