#!/usr/bin/env node
// A keyed cut-out, as a .glb the game can load: one textured quad, standing on the ground, at the
// spec's metres.
//
//   node tools/assetgen/card.mjs --id palm
//   node tools/assetgen/card.mjs --all --out apps/coast/public/assets/generated
//
// WHY A CARD IS NOT A COMPROMISE HERE, for roadside kinds. Every nature, prop and architecture
// entry in `models.ts` is declared `yaws: [0]` — the game bakes it from exactly ONE angle and
// shows that sprite for the whole approach. The bake camera is a 6.5x long lens at
// `DEFAULT_PITCH` = 9 degrees above the horizon, so a flat card foreshortens by cos(9°) = 0.988:
// a hundredth of its height. The mesh a reconstruction would give us is thrown away by the same
// bake, at the same yaw, into the same 128-pixel cell.
//
// WHERE IT IS A COMPROMISE, and where these must not be used: anything baked at more than one yaw.
// `TRAFFIC_YAWS` is twelve angles across four pitches and `HERO_YAWS` is sixteen; a card turned 90
// degrees is an edge. Cars need the real mesh, which is what `generate.mjs` asks TRELLIS for.
//
// THE MATERIAL IS UNLIT (`KHR_materials_unlit`, which three's GLTFLoader turns into a
// MeshBasicMaterial). The cut-out is a photograph and carries its own light; letting the bake's
// lamps fall on it a second time gives a palm lit from two directions at once. It is also what
// keeps `SpriteAtlas`'s material pass — which flattens shading and clamps metalness on every
// MeshStandardMaterial it finds — from touching these at all.
//
// ALPHA IS `MASK`, not `BLEND`. Blended transparency is order-dependent and a card at a sharp
// angle to another card will fight over who draws first; a cutout mask has no such argument, and
// our alpha is a hard key with a one-pixel ramp, which is exactly what a mask wants.

import { execFileSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { dimsOf, loadSpecs } from './proportion.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

const magick = (args) => execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim()

/** Longest edge of the baked texture. The biggest cell any of these is drawn into is 256 px. */
const TEXTURE = 512
/**
 * Palette size. These are photographs, so 256 colours is a real reduction — and at the size they
 * are seen it is invisible: the largest atlas cell in the manifest is 256 px and the viewer shows
 * them at about 500. It is the difference between 9.6 MB of textures in the repository and 2.5.
 * `--colors 0` turns it off for anything that turns out to band.
 */
const COLOURS = 256

const GL = { FLOAT: 5126, USHORT: 5123, ARRAY_BUFFER: 34962, ELEMENT_ARRAY_BUFFER: 34963, LINEAR: 9729, LINEAR_MIPMAP_LINEAR: 9987, CLAMP: 33071 }

const pad4 = (n) => (n + 3) & ~3

/**
 * Trim the cut-out to its subject and shrink it to the texture budget. Returns the PNG and the
 * trimmed aspect, which is what sets the card's width: the spec's `widthM` is the width of the
 * OBJECT, and a three-quarter view of it is wider than that, so measuring the picture is right
 * where trusting the metres would stretch it.
 */
function texture(src, out, colours = COLOURS) {
  magick([src, '-trim', '+repage', '-resize', `${TEXTURE}x${TEXTURE}>`, '-strip',
    ...(colours ? ['-colors', String(colours)] : []), '-define', 'png:compression-level=9', out])
  const [w, h] = magick([out, '-format', '%w %h', 'info:']).split(' ').map(Number)
  return { png: readFileSync(out), w, h }
}

/**
 * One quad, standing on y=0, centred on x, facing +Z.
 *
 * Facing +Z is not arbitrary. Roadside ModelDefs carry `spin: 180` because yaw 0 in this game means
 * SEEN FROM BEHIND — right for a car driving away, wrong for a diner — so the bake turns the model
 * half a turn and photographs it from -Z. A card built facing +Z is turned to face the camera by
 * that same half turn, and the image lands the way round it was drawn.
 */
export function cardGlb(pngBytes, widthM, heightM, name) {
  const hw = widthM / 2
  const positions = new Float32Array([-hw, 0, 0, hw, 0, 0, hw, heightM, 0, -hw, heightM, 0])
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3])

  const parts = [Buffer.from(positions.buffer), Buffer.from(uvs.buffer), Buffer.from(indices.buffer), pngBytes]
  const views = []
  let offset = 0
  const bin = []
  for (const p of parts) {
    views.push({ byteOffset: offset, byteLength: p.length })
    bin.push(p)
    const pad = pad4(p.length) - p.length
    if (pad) bin.push(Buffer.alloc(pad))
    offset += p.length + pad
  }

  const json = {
    asset: { version: '2.0', generator: 'apex-conduit tools/assetgen/card.mjs' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
    materials: [
      {
        name,
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 },
        alphaMode: 'MASK',
        alphaCutoff: 0.5,
        doubleSided: true,
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    textures: [{ sampler: 0, source: 0 }],
    samplers: [{ magFilter: GL.LINEAR, minFilter: GL.LINEAR_MIPMAP_LINEAR, wrapS: GL.CLAMP, wrapT: GL.CLAMP }],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: GL.FLOAT, count: 4, type: 'VEC3', min: [-hw, 0, 0], max: [hw, heightM, 0] },
      { bufferView: 1, componentType: GL.FLOAT, count: 4, type: 'VEC2' },
      { bufferView: 2, componentType: GL.USHORT, count: 6, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, ...views[0], target: GL.ARRAY_BUFFER },
      { buffer: 0, ...views[1], target: GL.ARRAY_BUFFER },
      { buffer: 0, ...views[2], target: GL.ELEMENT_ARRAY_BUFFER },
      { buffer: 0, ...views[3] },
    ],
    buffers: [{ byteLength: offset }],
  }

  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = Buffer.concat([jsonBuf, Buffer.alloc(pad4(jsonBuf.length) - jsonBuf.length, 0x20)])
  const binBuf = Buffer.concat(bin)
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonPad.length + 8 + binBuf.length, 8)
  const chunk = (data, type) => {
    const head = Buffer.alloc(8)
    head.writeUInt32LE(data.length, 0)
    head.write(type, 4, 'ascii')
    return Buffer.concat([head, data])
  }
  return Buffer.concat([header, chunk(jsonPad, 'JSON'), chunk(binBuf, 'BIN\0')])
}

/** The keyed cut-out for a spec: view 1, which is the one generated rather than rotated. */
export function cutoutFor(id, dir = 'ext/assetgen') {
  const d = path.join(ROOT, dir, id)
  if (!existsSync(d)) return null
  const hit = readdirSync(d).filter((f) => f.startsWith('view-0-') && f.endsWith('-keyed.png')).sort()
  return hit.length ? path.join(d, hit[0]) : null
}

export function buildCard(spec, out, { dir = 'ext/assetgen', colours = COLOURS } = {}) {
  const src = cutoutFor(spec.id, dir)
  if (!src) throw new Error(`${spec.id}: no keyed cut-out — run generate.mjs first`)
  mkdirSync(path.dirname(out), { recursive: true })
  const tex = `${out}.texture.png`
  const { png, w, h } = texture(src, tex, colours)
  const d = dimsOf(spec)
  // Height is the spec's, in metres. Width follows the picture, not `widthM`: the object is
  // photographed at an angle and its picture is wider than its plan is deep.
  const widthM = d.height * (w / h)
  writeFileSync(out, cardGlb(png, widthM, d.height, spec.id))
  rmSync(tex, { force: true })
  return { file: out, widthM: Math.round(widthM * 100) / 100, heightM: d.height, texture: `${w}x${h}`, bytes: png.length }
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
  node tools/assetgen/card.mjs --id palm [--out DIR]

    --id ID     one asset that has been generated
    --all       every generated asset whose class is not vehicle
    --out DIR   default ext/assetgen/<id>/, i.e. beside the cut-out
    --colors N  palette size, 0 for full colour (default ${COLOURS})
`)
    process.exit(has('help') ? 0 : 1)
  }

  const { assets } = loadSpecs()
  const chosen = id
    ? assets.filter((a) => a.id === id)
    : assets.filter((a) => a.class !== 'vehicle' && cutoutFor(a.id))
  if (!chosen.length) {
    console.error(id ? `no asset ${JSON.stringify(id)}` : 'nothing generated yet — run generate.mjs')
    process.exit(1)
  }

  let total = 0
  for (const spec of chosen) {
    const out = flag('out') ? path.resolve(ROOT, flag('out'), `${spec.id}.glb`) : path.join(ROOT, 'ext/assetgen', spec.id, `${spec.id}.glb`)
    const r = buildCard(spec, out, { colours: Number(flag('colors', COLOURS)) })
    total += r.bytes
    console.log(`${path.relative(ROOT, r.file)}  ${r.widthM}x${r.heightM} m, texture ${r.texture}, ${(r.bytes / 1024).toFixed(0)} KB`)
  }
  console.log(`${chosen.length} cards, ${(total / 1024 / 1024).toFixed(1)} MB of texture`)
}
