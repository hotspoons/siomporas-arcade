#!/usr/bin/env node
// A reconstruction, finished into something a game can ship: simplify, unlit, compress.
//
//   node tools/assetgen/finish.mjs --id hero-prototype
//   node tools/assetgen/finish.mjs --all --out apps/coast/public/assets/generated
//
// WHAT COMES IN is what TRELLIS hands back: around 400k faces with two 2048px PBR maps, 26 MB a
// subject. That is right for a reconstruction and about fifty times what a sprite bake in a
// 256-pixel cell can resolve, and 44 of them is 1.1 GB against a 64 MiB Cloudflare Worker bundle.
//
// THE SIMPLIFIER IS MESHOPTIMIZER, AND THAT IS NOT A DETAIL. The first version of this ran
// Blender's decimate modifier at the same target — 20k faces — and the hero car came back CRACKED:
// black tears all over the bodywork, the windscreen blown out to white. The raw 26 MB mesh was
// clean, so the damage was ours. A collapse decimator at nineteen-to-one pulls UV seams apart and
// the texture rips along them; meshoptimizer weights the attributes and keeps the seams together.
// Same face count, no cracks. Blender is out of this path entirely.
//
// UNLIT, AND BEFORE COMPRESSION. TRELLIS bakes its own lighting into the base colour, and
// `SpriteAtlas` then lights it again — the hero read muddy brown rather than red until the material
// became `KHR_materials_unlit`. Order matters here for a boring reason: the unlit transform
// decompresses to do its work, so running it after Draco costs six megabytes and undoes the point.
//
// WHAT GOES OUT is roughly 1.2 MB: 20k faces, a 1024px WebP base colour, Draco geometry. Metallic
// and roughness are dropped by `optimize` along the way, which costs nothing — the bake flattens
// shading and clamps metalness on everything it draws.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { loadSpecs } from './proportion.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

/** Pinned: a silent major upgrade of an asset tool is a silent change to every asset. */
const CLI = ['--yes', '@gltf-transform/cli@4']

const gltf = (args) => execFileSync('npx', [...CLI, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, cwd: ROOT })

/**
 * `ratio` is a fraction of the original triangle count, not an absolute target: the service's own
 * output varies between two and twelve million faces before its `to_glb` decimation, so a fixed
 * number lands somewhere different on every subject. 0.05 of ~400k is the 20k the bake wants.
 */
export function finish(src, out, { ratio = 0.05, error = 0.001, texture = 1024, unlit = true } = {}) {
  mkdirSync(path.dirname(out), { recursive: true })
  const a = `${out}.simplified.glb`
  const b = `${out}.unlit.glb`
  gltf(['simplify', src, a, '--ratio', String(ratio), '--error', String(error)])
  if (unlit) gltf(['unlit', a, b])
  gltf(['optimize', unlit ? b : a, out, '--texture-compress', 'webp', '--texture-size', String(texture), '--compress', 'draco', '--simplify', 'false'])
  rmSync(a, { force: true })
  rmSync(b, { force: true })
  return { file: out, bytes: statSync(out).size, from: statSync(src).size }
}

// --- CLI ---------------------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const flag = (n, d) => {
    const i = argv.indexOf(`--${n}`)
    return i === -1 ? d : argv[i + 1]
  }
  const has = (n) => argv.includes(`--${n}`)

  const id = flag('id')
  if ((!id && !has('all')) || has('help')) {
    console.log(`
  node tools/assetgen/finish.mjs --id hero-prototype [--out DIR]

    --id ID        one reconstruction from ext/assetgen/<id>/<id>.glb
    --all          every reconstruction on disk
    --out DIR      where the finished .glb goes (default: beside the source)
    --ratio N      fraction of triangles to keep (default 0.05)
    --texture N    longest texture edge (default 1024)
    --lit          keep the PBR material — the bake will light it a second time
`)
    process.exit(has('help') ? 0 : 1)
  }

  const { assets } = loadSpecs()
  const chosen = assets.filter((a) => (id ? a.id === id : existsSync(path.join(ROOT, 'ext/assetgen', a.id, `${a.id}.glb`))))
  if (!chosen.length) {
    console.error(id ? `no reconstruction for ${JSON.stringify(id)} — run generate.mjs --recon first` : 'nothing reconstructed yet')
    process.exit(1)
  }

  let total = 0
  for (const spec of chosen) {
    const src = path.join(ROOT, 'ext/assetgen', spec.id, `${spec.id}.glb`)
    const out = flag('out') ? path.resolve(ROOT, flag('out'), `${spec.id}.glb`) : path.join(ROOT, 'ext/assetgen', spec.id, `${spec.id}-finished.glb`)
    const r = finish(src, out, {
      ratio: Number(flag('ratio', 0.05)),
      texture: Number(flag('texture', 1024)),
      unlit: !has('lit'),
    })
    total += r.bytes
    console.log(`${path.relative(ROOT, out)}  ${(r.from / 1e6).toFixed(1)} MB → ${(r.bytes / 1e6).toFixed(2)} MB`)
  }
  console.log(`${chosen.length} finished, ${(total / 1e6).toFixed(1)} MB total`)
}
