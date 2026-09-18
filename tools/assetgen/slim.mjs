#!/usr/bin/env node
// Bring a shipped model down to a face count a sprite can actually resolve.
//
//   node tools/assetgen/slim.mjs --check                  # what every model costs now
//   node tools/assetgen/slim.mjs --all                    # rewrite them in place
//   node tools/assetgen/slim.mjs --all --faces 12000
//
// WHY THIS EXISTS, given `finish.mjs` already simplifies. It simplifies by RATIO — five per cent of
// whatever the reconstruction service handed over — and its own header records that the service's
// output varies between two and twelve million faces. Five per cent of a variable is a variable: the
// comment says "0.05 of ~400k is the 20k the bake wants", and for a 400k input that is true, but the
// bush arrived at five and a half million and came out at 276,505. Nothing downstream complained,
// because the shipped atlas meant nobody ever loaded a mesh at runtime, so a two-orders-of-magnitude
// miss sat there costing only disk.
//
// So the target here is a NUMBER OF FACES, not a fraction. Each file is inspected, the ratio worked
// out from what is actually in it, and the result checked. A ratio is the only knob the simplifier
// takes; it is not the knob anyone wants to set.
//
// WHY NOT BLENDER. It was tried, and `finish.mjs` records what happened: Blender's collapse decimator
// at this kind of reduction pulls UV seams apart and the texture rips along them — the hero car came
// back with black tears across the bodywork and a blown-out windscreen. meshoptimizer weights the
// attributes and holds the seams together at the same face count. Blender is the better tool for
// plenty in this repo; for this particular cut it already lost on the evidence.
//
// WHAT A FACE IS WORTH HERE. Every one of these is photographed into a cell of at most 256 pixels and
// then drawn as a quad. A 276k-face bush resolves to roughly thirty pixels of screen. The bake cannot
// see past about ten thousand faces on anything, and most of these are shrubs.

import { execFileSync } from 'node:child_process'
import { readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const DIR = path.join(ROOT, 'apps/coast/public/assets/generated')
const CLI = ['--yes', '@gltf-transform/cli@4']
const gltf = (args) => execFileSync('npx', [...CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, cwd: ROOT })

/** Faces in a .glb, read back from the tool rather than assumed. */
export function faceCount(file) {
  const out = gltf(['inspect', file])
  let total = 0
  // The MESHES table prints glPrimitives per mesh; that is the triangle count.
  for (const line of out.split('\n')) {
    const m = /│\s*\d+\s*│[^│]*│\s*TRIANGLES\s*│[^│]*│\s*([\d,]+)\s*│/.exec(line)
    if (m) total += Number(m[1].replace(/,/g, ''))
  }
  return total
}

/**
 * Simplify to `faces`, then put the compression back. `error` is meshoptimizer's budget: the default
 * in `finish.mjs` is tight enough that an aggressive ratio quietly stops early, so this asks for more
 * room and then checks what it actually got.
 */
export function slim(file, { faces = 12000, error = 0.02, texture = 512 } = {}) {
  const before = { faces: faceCount(file), bytes: statSync(file).size }
  if (before.faces <= faces) return { ...before, after: before, skipped: true }
  const a = `${file}.slim-a.glb`
  const b = `${file}.slim-b.glb`
  const ratio = Math.max(0.0005, faces / before.faces)
  try {
    gltf(['simplify', file, a, '--ratio', String(ratio), '--error', String(error)])
    gltf(['optimize', a, b, '--texture-compress', 'webp', '--texture-size', String(texture), '--compress', 'draco', '--simplify', 'false'])
    const after = { faces: faceCount(b), bytes: statSync(b).size }
    renameSync(b, file)
    return { ...before, after, ratio }
  } finally {
    rmSync(a, { force: true })
    rmSync(b, { force: true })
  }
}

// --- CLI ---------------------------------------------------------------------------------------
// Only when run directly: `finish.mjs` and the checks import `slim` and `faceCount` from here.
const argv = process.argv[1]?.endsWith('slim.mjs') ? process.argv.slice(2) : null
if (argv) main()

function main() {
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
      const n = faceCount(p)
      total += n
      bytes += statSync(p).size
      if (n > target) over.push([f, n])
    }
    over.sort((x, y) => y[1] - x[1])
    console.log(`${files.length} models · ${(bytes / 1e6).toFixed(1)} MB · ${(total / 1e6).toFixed(2)}M faces · target ${target.toLocaleString()} each`)
    console.log(`${over.length} over target:`)
    for (const [f, n] of over.slice(0, 12)) console.log(`  ${f.padEnd(30)} ${n.toLocaleString().padStart(10)}`)
    process.exit(over.length ? 1 : 0)
  }

  if (!argv.includes('--all')) {
    console.error('usage: slim.mjs --check | --all [--faces N] [--error E] [--texture PX]')
    process.exit(2)
  }
  let fromF = 0
  let toF = 0
  let fromB = 0
  let toB = 0
  for (const f of files) {
    const p = path.join(DIR, f)
    const r = slim(p, { faces: target, error: Number(flag('error', 0.02)), texture: Number(flag('texture', 512)) })
    fromF += r.faces
    toF += r.after.faces
    fromB += r.bytes
    toB += r.after.bytes
    const tag = r.skipped ? 'already small' : `${r.faces.toLocaleString()} → ${r.after.faces.toLocaleString()} faces`
    console.log(`  ${f.padEnd(30)} ${tag.padEnd(30)} ${(r.bytes / 1024).toFixed(0)} → ${(r.after.bytes / 1024).toFixed(0)} KB`)
  }
  console.log(`\n${(fromF / 1e6).toFixed(2)}M → ${(toF / 1e6).toFixed(2)}M faces · ${(fromB / 1e6).toFixed(1)} → ${(toB / 1e6).toFixed(1)} MB`)
}
