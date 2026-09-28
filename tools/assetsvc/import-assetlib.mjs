#!/usr/bin/env node
// Bring an assetlib library into the assetsvc catalog.
//
// Rich, 2026-09-28: "we don't need an external service that will be wiped on a fresh clone
// sticking around, everything needs to be folded in here", and on the 4 GB of output: "assets can
// be symlinked for local dev and once we get this running well in the cluster I will want to
// requeue a rebake of everything anyways, so eventually we'll delete."
//
// So this is a MIGRATION, run once per library, and it is deliberately not a compatibility shim.
// The two trees hold the same things under different names:
//
//   assetlib                          assetsvc
//   out/<id>/meta.json                <id>/item.json
//   out/<id>/view-1.png               <id>/views/view-1.png
//   out/<id>/<id>.glb                 <id>/mesh.glb
//   out/<id>/<id>-finished.glb        <id>/mesh.finished.glb
//   out/<id>/<id>-glass-finished.glb  <id>/mesh.glass.glb
//
// SYMLINKS BY DEFAULT. The meshes are most of four gigabytes and copying them doubles that for no
// gain on a machine that already has them; `--copy` is there for the cluster, where the source
// tree will not be present. A symlink that dangles is reported rather than left to be discovered
// as a 404 in the panel.
//
//   node tools/assetsvc/import-assetlib.mjs --from ext/assetlib --to <data-dir>
//   node tools/assetsvc/import-assetlib.mjs --from ext/assetlib --to <data-dir> --copy --dry-run

import { copyFile, mkdir, readdir, readFile, symlink, writeFile, stat, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i === -1 ? d : process.argv[i + 1] }
const has = (k) => process.argv.includes(`--${k}`)

const FROM = path.resolve(arg('from', 'ext/assetlib'))
const TO = path.resolve(arg('to', process.env.ASSETSVC_DATA ?? 'ext/assetsvc'))
const COPY = has('copy')
const DRY = has('dry-run')
const OUT = path.join(FROM, 'out')

if (!existsSync(OUT)) {
  console.error(`no library at ${OUT}`)
  process.exit(1)
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * assetlib's meta.json in assetsvc's item.json shape.
 *
 * `prompt` and `negative` come across verbatim — they are the expensive part, the thing a person
 * or an agent spent effort on, and re-deriving them from the spec would quietly drop whatever was
 * hand-edited. `chosen` names the view that was meshed, which assetlib records as `view`.
 */
function toItem(meta, views) {
  return {
    id: meta.id,
    subject: meta.subject ?? meta.id.replace(/-/g, ' '),
    prompt: meta.prompt ?? '',
    negative: meta.negative ?? meta.avoid ?? '',
    // everything assetlib knew that assetsvc has no column for, kept rather than dropped: the
    // model and seed are what make a result reproducible and there is nowhere else to put them
    origin: {
      library: 'assetlib',
      class: meta.class ?? null,
      view: meta.view ?? null,
      chroma: meta.chroma ?? null,
      engine: meta.engine ?? null,
      builtAt: meta.builtAt ?? null,
    },
    chosen: views.includes(meta.view) ? meta.view : views[views.length - 1] ?? null,
    importedAt: new Date().toISOString(),
  }
}

/** Link or copy, and say which files were missing rather than leaving a 404 to be found later. */
async function place(src, dst) {
  if (!existsSync(src)) return false
  if (DRY) return true
  await rm(dst, { force: true })
  if (COPY) await copyFile(src, dst)
  else await symlink(path.resolve(src), dst)
  return true
}

const ids = (await readdir(OUT, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && SAFE_ID.test(d.name))
  .map((d) => d.name)
  .sort()

let imported = 0
let skipped = 0
let meshes = 0
let bytes = 0
const problems = []

for (const id of ids) {
  const src = path.join(OUT, id)
  const meta = await readFile(path.join(src, 'meta.json'), 'utf8').then(JSON.parse).catch(() => null)
  if (!meta) { skipped += 1; problems.push(`${id}: no meta.json`); continue }

  const files = await readdir(src)
  // the keyed views are the ones with the backdrop removed, which is what gets meshed; keep both
  // so the panel can show what was drawn as well as what was used
  const views = files.filter((f) => /^view-.*\.png$/.test(f)).sort()
  if (!views.length) problems.push(`${id}: no views`)

  const dst = path.join(TO, id)
  if (!DRY) await mkdir(path.join(dst, 'views'), { recursive: true })
  for (const v of views) await place(path.join(src, v), path.join(dst, 'views', v))

  const gotRaw = await place(path.join(src, `${id}.glb`), path.join(dst, 'mesh.glb'))
  const gotFin = await place(path.join(src, `${id}-finished.glb`), path.join(dst, 'mesh.finished.glb'))
  await place(path.join(src, `${id}-glass-finished.glb`), path.join(dst, 'mesh.glass.glb'))
  if (gotRaw || gotFin) meshes += 1
  for (const f of [`${id}.glb`, `${id}-finished.glb`]) {
    const s = await stat(path.join(src, f)).catch(() => null)
    if (s) bytes += s.size
  }

  if (!DRY) await writeFile(path.join(dst, 'item.json'), JSON.stringify(toItem(meta, views), null, 1))
  imported += 1
}

console.log(`${DRY ? '[dry run] ' : ''}${imported} items into ${TO}`)
console.log(`  ${meshes} with a mesh, ${(bytes / 2 ** 30).toFixed(2)} GiB ${COPY ? 'copied' : 'symlinked'}`)
if (skipped) console.log(`  ${skipped} skipped`)
for (const p of problems.slice(0, 12)) console.log(`  - ${p}`)
if (problems.length > 12) console.log(`  … and ${problems.length - 12} more`)
