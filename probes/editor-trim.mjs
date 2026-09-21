#!/usr/bin/env node
// Trim a reconstructed bridge SPAN: squash everything below the deck's underside, then finish it.
//
//   node probes/editor-trim.mjs <id> [--frac 0.15] [--stretch K] [--dry]
//
// Why: the viewer's `bridge_over` (src/structures.ts::buildBridges) puts the fitted model's BASE at
// road + clearance and builds its own abutments to the ground, so the asset has to be the span
// alone. flux.2-dev does not do "no piers": the overpass came back on two pairs of piers and the
// horse bridge on legs, however the sentence was written. Rather than spend generations, cut.
//
// How: the deck's underside is the lowest horizontal plane with a lot of vertices in it — piers
// and legs below it are thin, so a histogram of vertex height has a cliff there. Everything under
// the cliff is clamped UP to it, which folds the supports into degenerate slivers coplanar with
// the underside, where they are hidden by it. No triangles are removed, so nothing tears.
//
// `--stretch K` scales the long horizontal axis by K, for a subject the generator refused to make
// long enough (the horse bridge). It is a last resort and it is honest about being one: board
// siding gets wider, trusses get longer. Kept under ~2, it reads as a longer bridge, not a smear.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { NodeIO } from '@gltf-transform/core'
import { finish } from '../tools/assetgen/finish.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const WORK = process.env.CORRIDOR_ASSET_WORK ?? '/tmp/corridor-assets'
const DEST = path.join(ROOT, 'apps/corridor/public/assets')

const argv = process.argv.slice(2)
const id = argv.find((a) => !a.startsWith('--'))
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : Number(argv[i + 1])
}
if (!id) {
  console.error('usage: node probes/editor-trim.mjs <id> [--frac 0.15] [--stretch K] [--dry]')
  process.exit(2)
}
const frac = flag('frac', 0.15)
const stretch = flag('stretch', 1)
const dry = argv.includes('--dry')

const src = path.join(WORK, id, 'recon.glb')
if (!existsSync(src)) throw new Error(`no reconstruction at ${src}`)
const io = new NodeIO()
const doc = await io.read(src)

// gather every position (the reconstructions are one mesh under an identity node, but be general)
const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
const arrays = prims.map((p) => p.getAttribute('POSITION'))
let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity
for (const pos of arrays) {
  const a = pos.getArray()
  for (let i = 0; i < a.length; i += 3) {
    xmin = Math.min(xmin, a[i]); xmax = Math.max(xmax, a[i])
    ymin = Math.min(ymin, a[i + 1]); ymax = Math.max(ymax, a[i + 1])
    zmin = Math.min(zmin, a[i + 2]); zmax = Math.max(zmax, a[i + 2])
  }
}
const BINS = 120
const hist = new Array(BINS).fill(0)
const bin = (y) => Math.min(BINS - 1, Math.floor(((y - ymin) / (ymax - ymin)) * BINS))
for (const pos of arrays) {
  const a = pos.getArray()
  for (let i = 1; i < a.length; i += 3) hist[bin(a[i])]++
}
const peak = Math.max(...hist)
let cut = 0
while (cut < BINS - 1 && hist[cut] < frac * peak) cut++
const thr = ymin + ((ymax - ymin) * cut) / BINS
const below = hist.slice(0, cut).reduce((s, n) => s + n, 0)
const total = hist.reduce((s, n) => s + n, 0)
console.log(`${id}: bounds x ${(xmax - xmin).toFixed(3)} y ${(ymax - ymin).toFixed(3)} z ${(zmax - zmin).toFixed(3)}`)
console.log(`  underside at y=${thr.toFixed(3)} (bin ${cut}/${BINS}); ${((100 * below) / total).toFixed(1)}% of vertices are supports below it`)
console.log(`  after: height ${(ymax - thr).toFixed(3)}, long axis ${Math.max(xmax - xmin, zmax - zmin).toFixed(3)} × ${stretch} → aspect ${((Math.max(xmax - xmin, zmax - zmin) * stretch) / (ymax - thr)).toFixed(2)}:1`)
if (dry) process.exit(0)

const longIsX = xmax - xmin >= zmax - zmin
for (const pos of arrays) {
  const a = pos.getArray()
  for (let i = 0; i < a.length; i += 3) {
    if (a[i + 1] < thr) a[i + 1] = thr
    if (stretch !== 1) {
      if (longIsX) a[i] *= stretch
      else a[i + 2] *= stretch
    }
  }
  pos.setArray(a)
}
const trimmed = path.join(WORK, id, 'trimmed.glb')
await io.write(trimmed, doc)
const out = path.join(DEST, `${id}.glb`)
finish(trimmed, out, { unlit: false })
console.log(`  wrote ${out} (${(readFileSync(out).length / 2 ** 20).toFixed(2)} MB)`)
