#!/usr/bin/env node
// Bring a shipped model down to a face count a sprite can actually resolve.
//
//   node tools/assetgen/slim.mjs --check                  # what every model costs now
//   node tools/assetgen/slim.mjs --all                    # rewrite them in place
//   node tools/assetgen/slim.mjs --all --faces 12000
//
// WHY THIS EXISTS, given `finish.mjs` already simplifies. Two reasons, and the second is the one
// that matters.
//
// IT SIMPLIFIED BY RATIO. Five per cent of whatever the reconstruction service handed over — and
// `finish.mjs`'s own header records that the service's output varies between two and twelve million
// faces. Five per cent of a variable is a variable: the comment says "0.05 of ~400k is the 20k the
// bake wants", which is true of a 400k input, and the bush arrived at five and a half million and
// came out at 276,505. Nothing downstream complained, because the shipped atlas meant nobody ever
// loaded a mesh at runtime, so a two-orders-of-magnitude miss sat there costing only disk. The target
// here is a NUMBER OF FACES. A ratio is the only knob the simplifier takes; it is not the knob anyone
// wants to set.
//
// AND THE CAREFUL SIMPLIFIER CANNOT REACH IT ANYWAY. Ask meshoptimizer for 12,000 faces of that bush
// and it stops at 210,922 — at every error budget from 0.02 to unbounded, welded or not. It is doing
// the right thing: an edge-collapse simplifier can only collapse across connected geometry, and a
// reconstructed bush is thousands of disconnected leaf shells with nothing joining them. Pruning does
// not help either; the shells are not small, there are simply thousands of them.
//
// SO THE CAREFUL SIMPLIFIER IS ALL THIS DOES, and it does not get far. Every model floors at a fixed
// count — the same number at every attribute weight from 0.5 to 0.02 and every error budget from 0.05
// to unbounded, which is how you know the limit is connectivity and not quality:
//
//   hero rosso  149,630 → 94,408      bush            276,505 → 210,916
//   sedan        85,680 → 46,080      facade-lowrise  151,638 → 103,007
//
// SLOPPY REACHES THE TARGET AND RUINS THE ASSET. `simplifySloppy` clusters vertices and ignores
// topology, so it hits any number you ask for — 276,505 → 9,839 on the bush, 32.4 MB down to 9.7 MB
// across the set. Every sprite baked from the result came out shredded: the car a tangle of red
// slivers, the motel a pile of stripes. Clustering picks representative vertices and the UVs go with
// them, so the texture mapping is destroyed. This is the SAME failure `finish.mjs` records for
// Blender's decimate modifier, arrived at from the other direction. It is behind `--sloppy` and there
// is no good reason to pass it.
//
// WHAT WOULD ACTUALLY WORK is a remesh: rebuild the surface at a target resolution, which does not
// care that the input is in pieces — then unwrap it and bake the old texture onto the new UVs. That is
// Blender's job (voxel or quadriflow remesh, smart UV project, bake), and it is a pipeline rather than
// a step. Worth doing if these ever need to be geometry. They do not today: they are photographed into
// an atlas and the atlas is what ships.
//
// WHAT A FACE IS WORTH HERE. Every one of these is photographed into a cell of at most 256 pixels and
// drawn as a quad. A 276k-face bush resolves to about thirty pixels of screen.

import { execFileSync } from 'node:child_process'
import { readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import draco3d from 'draco3dgltf'

const ROOT = process.cwd()
const DIR = path.join(ROOT, 'apps/coast/public/assets/generated')
const gltf = (args) => execFileSync('npx', ['--yes', '@gltf-transform/cli@4', ...args], { encoding: 'utf8', maxBuffer: 1 << 28, cwd: ROOT })

/** How far above target a model may land before `--check` calls it out. */
const STALL = 1.6

let io = null
async function reader() {
  if (io) return io
  await MeshoptSimplifier.ready
  io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  })
  return io
}

/** Faces in a .glb, counted rather than assumed. */
export async function faceCount(file) {
  const doc = await (await reader()).read(file)
  let n = 0
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices()
      n += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3
    }
  }
  return Math.round(n)
}

/**
 * Cut one model to `faces`, sharing the budget between its primitives by size, and put the
 * compression back. Returns what each primitive did and which simplifier got it there.
 */
export async function slim(file, { faces = 12000, texture = 512, sloppy = false } = {}) {
  const rd = await reader()
  const doc = await rd.read(file)
  const prims = doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
    .filter((p) => p.getIndices() && p.getAttribute('POSITION'))
  const before = prims.reduce((a, p) => a + p.getIndices().getCount() / 3, 0)
  const bytes = statSync(file).size
  if (!prims.length || before <= faces) return { before, after: before, bytes, afterBytes: bytes, how: 'left alone' }

  let how = 'attributes'
  for (const prim of prims) {
    const idx = new Uint32Array(prim.getIndices().getArray())
    const pos = new Float32Array(prim.getAttribute('POSITION').getArray())
    const share = Math.max(300, Math.round((faces * (idx.length / 3)) / before))
    const targetIdx = Math.min(idx.length, share * 3)
    // Careful first: it keeps UV seams together, which is the difference between a car and a car
    // with black tears across it.
    const uv = prim.getAttribute('TEXCOORD_0')
    let out
    if (uv) {
      const a = new Float32Array(uv.getArray())
      out = MeshoptSimplifier.simplifyWithAttributes(idx, pos, 3, a, 2, [0.5, 0.5], null, null, targetIdx, 0.05)[0]
    } else {
      out = MeshoptSimplifier.simplify(idx, pos, 3, targetIdx, 0.05)[0]
    }
    // Stalled well above target: the mesh is shells, not a surface, and only clustering would get
    // there — at the cost of the UVs, and so of the texture. Opt in and look at what you get.
    if (sloppy && out.length / 3 > share * STALL) {
      out = MeshoptSimplifier.simplifySloppy(idx, pos, 3, null, targetIdx, 1)[0]
      how = 'SLOPPY — check the sprite'
    }
    prim.getIndices().setArray(out.constructor === Uint32Array ? out : new Uint32Array(out))
  }
  // Drop the vertices nothing points at any more, then re-compress.
  const a = `${file}.slim-a.glb`
  const b = `${file}.slim-b.glb`
  await rd.write(a, doc)
  try {
    gltf(['optimize', a, b, '--texture-compress', 'webp', '--texture-size', String(texture), '--compress', 'draco', '--simplify', 'false'])
    const after = await faceCount(b)
    renameSync(b, file)
    return { before: Math.round(before), after, bytes, afterBytes: statSync(file).size, how }
  } finally {
    rmSync(a, { force: true })
    rmSync(b, { force: true })
  }
}

// --- CLI ---------------------------------------------------------------------------------------
// Only when run directly: the checks import `slim` and `faceCount` from here.
if (process.argv[1]?.endsWith('slim.mjs')) await main()

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name, dflt) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
  }
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith('.glb'))
    .sort()
  const target = Number(flag('faces', 12000))

  if (argv.includes('--check')) {
    let total = 0
    let bytes = 0
    const over = []
    for (const f of files) {
      const p = path.join(DIR, f)
      const n = await faceCount(p)
      total += n
      bytes += statSync(p).size
      if (n > target * STALL) over.push([f, n])
    }
    over.sort((x, y) => y[1] - x[1])
    console.log(`${files.length} models · ${(bytes / 1e6).toFixed(1)} MB · ${(total / 1e6).toFixed(2)}M faces · target ${target.toLocaleString()} each`)
    console.log(`${over.length} over target:`)
    for (const [f, n] of over.slice(0, 12)) console.log(`  ${f.padEnd(30)} ${n.toLocaleString().padStart(10)}`)
    process.exit(over.length ? 1 : 0)
  }

  if (!argv.includes('--all')) {
    console.error('usage: slim.mjs --check | --all [--faces N] [--texture PX] [--sloppy]')
    process.exit(2)
  }
  let fromF = 0
  let toF = 0
  let fromB = 0
  let toB = 0
  for (const f of files) {
    const r = await slim(path.join(DIR, f), { faces: target, texture: Number(flag('texture', 512)), sloppy: argv.includes('--sloppy') })
    fromF += r.before
    toF += r.after
    fromB += r.bytes
    toB += r.afterBytes
    console.log(`  ${f.padEnd(30)} ${`${r.before.toLocaleString()} → ${r.after.toLocaleString()}`.padEnd(22)} ${(r.bytes / 1024).toFixed(0).padStart(5)} → ${(r.afterBytes / 1024).toFixed(0).padStart(5)} KB   ${r.how}`)
  }
  console.log(`\n${(fromF / 1e6).toFixed(2)}M → ${(toF / 1e6).toFixed(2)}M faces · ${(fromB / 1e6).toFixed(1)} → ${(toB / 1e6).toFixed(1)} MB`)
}
