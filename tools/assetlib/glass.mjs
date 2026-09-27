#!/usr/bin/env node
// Turn a reconstruction's glazing into actual glass.
//
//   node ext/assetlib/tool/glass.mjs --id nsx-na1
//   node ext/assetlib/tool/glass.mjs --id nsx-na1 --debug   # paint the selection magenta instead
//
// WHY THIS AND NOT MORE HOLE-FILLING. fillholes.mjs stops TRELLIS inventing an interior, and it
// works, but it can only ever produce an OPAQUE panel where the window should be. A car whose
// windows are painted-on dark panels reads as a toy. The glazing is not a texture problem at all —
// it is a material problem, and glTF has the material: KHR_materials_transmission with a real ior.
//
// THE SELECTION IS BY COLOUR, WITH A HEIGHT GUARD. Glass bakes dark and desaturated, so luma picks
// it out — but so are the tyres, the bumpers, the grille and the sill trim, and those must stay
// opaque. Every one of them lives low on the body, so a floor at a fraction of the model's height
// separates them cleanly. Both thresholds are flags because the right value is per-asset and the
// only honest way to set one is to look: `--debug` writes the same split with the selection
// painted bright magenta, which is much faster to judge than a transmissive render.
//
// It runs on the RAW TRELLIS glb rather than the finished one, for two reasons: the finished glb
// is Draco-compressed (decoding it here would need the decoder wired up for no benefit), and its
// texture has already been squeezed to 1024px WebP, which blurs exactly the dark edges the
// classifier reads. Finish afterwards, not before.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { KHRMaterialsTransmission, KHRMaterialsIOR, KHRMaterialsVolume } from '@gltf-transform/extensions'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.resolve(HERE, '..')

const magick = (args) => execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 })

/** Decode a glTF texture's bytes to a flat RGBA buffer via ImageMagick, whatever the mime type. */
function decodeTexture(bytes, mime, tmpDir) {
  const ext = (mime ?? 'image/png').split('/')[1].replace('jpeg', 'jpg')
  const src = path.join(tmpDir, `tex.${ext}`)
  const raw = path.join(tmpDir, 'tex.rgba')
  writeFileSync(src, Buffer.from(bytes))
  const size = magick([src, '-format', '%wx%h', 'info:']).trim()
  const [w, h] = size.split('x').map(Number)
  magick([src, '-depth', '8', `RGBA:${raw}`])
  const data = readFileSync(raw)
  rmSync(src, { force: true }); rmSync(raw, { force: true })
  return { data, w, h }
}

const wrap = (v) => { const f = v - Math.floor(v); return f < 0 ? f + 1 : f }

/**
 * How much a texel is the key colour, per key. Each is the key's channels beating the others, so a
 * partly-blurred edge texel scores low and a solid painted pane scores near 1.
 */
const KEY_TEST = {
  magenta: (r, g, b) => Math.min(r, b) - g,
  blue:    (r, g, b) => b - Math.max(r, g),
  red:     (r, g, b) => r - Math.max(g, b),
  green:   (r, g, b) => g - Math.max(r, b),
  cyan:    (r, g, b) => Math.min(g, b) - r,
}

export async function separateGlass(src, out, opts = {}) {
  const { luma = 0.22, minHeight = 0.40, maxUp = 0.86, roofBand = 0.85, debug = false } = opts
  // A KEYED GLASS COLOUR MAKES THIS A LOOKUP. Without one we fall back to the old heuristic —
  // dark, low saturation, above a height floor, not facing straight up — which was tuned on one
  // car and does not port. Its worst case is a black car, where every panel reads as glazing and
  // the whole body turns to glass. Everything generated from now on carries a key.
  const key = opts.glassKey ? KEY_TEST[opts.glassKey] : null
  const keyCut = opts.keyCut ?? 0.18
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const doc = await io.read(src)
  const root = doc.getRoot()

  const tmpDir = path.join(path.dirname(out), '.glass-tmp')
  mkdirSync(tmpDir, { recursive: true })

  const transmission = doc.createExtension(KHRMaterialsTransmission)
  const ior = doc.createExtension(KHRMaterialsIOR)
  const volume = doc.createExtension(KHRMaterialsVolume)

  let picked = 0, total = 0
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')
      const uv = prim.getAttribute('TEXCOORD_0')
      const idx = prim.getIndices()
      const mat = prim.getMaterial()
      const tex = mat?.getBaseColorTexture()
      if (!pos || !uv || !idx || !tex) continue

      const { data, w, h } = decodeTexture(tex.getImage(), tex.getMimeType(), tmpDir)

      // The height floor is relative to this mesh's own bounding box, so it does not care what
      // scale TRELLIS happened to normalise to.
      const min = pos.getMin([0, 0, 0]), max = pos.getMax([0, 0, 0])
      const yMin = min[1], yRange = max[1] - yMin || 1
      const floorY = yMin + yRange * minHeight

      const count = idx.getCount()
      const bodyIdx = [], glassIdx = []
      const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0]
      const ua = [0, 0], ub = [0, 0], uc = [0, 0]
      for (let t = 0; t < count; t += 3) {
        const i0 = idx.getScalar(t), i1 = idx.getScalar(t + 1), i2 = idx.getScalar(t + 2)
        pos.getElement(i0, a); pos.getElement(i1, b); pos.getElement(i2, c)
        const cy = (a[1] + b[1] + c[1]) / 3
        let glass = false
        if (key) {
          uv.getElement(i0, ua); uv.getElement(i1, ub); uv.getElement(i2, uc)
          const px = Math.min(w - 1, Math.floor(wrap((ua[0] + ub[0] + uc[0]) / 3) * w))
          const py = Math.min(h - 1, Math.floor(wrap((ua[1] + ub[1] + uc[1]) / 3) * h))
          const o = (py * w + px) * 4
          glass = key(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255) > keyCut
          ;(glass ? glassIdx : bodyIdx).push(i0, i1, i2)
          total += 1
          if (glass) picked += 1
          continue
        }
        // A NEARLY HORIZONTAL UPWARD FACE AT THE TOP OF THE CAR IS A ROOF. Rejecting every
        // near-flat face was too blunt: a cab-forward supercar's windscreen is raked so far back
        // that its normal points almost as far up as the roof's, and the NSX lost its entire
        // windscreen while keeping its side glass. Measured on that mesh — of 40,797 dark
        // near-flat faces, only 5,281 sat in the top tenth of the body, and those are the roof;
        // the other 35,000 were windscreen. So the normal test only applies above `roofBand`.
        // Neither normal nor height separates roof from screen on its own; together they do.
        let ny = 0
        {
          const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2]
          const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2]
          const nx = e1y * e2z - e1z * e2y, nyy = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
          const len = Math.hypot(nx, nyy, nz) || 1
          ny = Math.abs(nyy / len)
        }
        const heightFrac = (cy - yMin) / yRange
        if (cy >= floorY && !(ny > maxUp && heightFrac > roofBand)) {
          uv.getElement(i0, ua); uv.getElement(i1, ub); uv.getElement(i2, uc)
          // The centroid texel, not a corner: a corner sits on the seam between glass and pillar
          // and flips with rounding.
          const px = Math.min(w - 1, Math.floor(wrap((ua[0] + ub[0] + uc[0]) / 3) * w))
          const py = Math.min(h - 1, Math.floor(wrap((ua[1] + ub[1] + uc[1]) / 3) * h))
          const o = (py * w + px) * 4
          const r = data[o] / 255, g = data[o + 1] / 255, bl = data[o + 2] / 255
          const L = 0.2126 * r + 0.7152 * g + 0.0722 * bl
          const sat = Math.max(r, g, bl) - Math.min(r, g, bl)
          // Dark AND neutral. The saturation test is what keeps deep red paint in shadow opaque.
          glass = L < luma && sat < 0.18
        }
        ;(glass ? glassIdx : bodyIdx).push(i0, i1, i2)
        total += 1
        if (glass) picked += 1
      }

      // GROW THE SELECTION BY ONE FACE RING. A triangle straddling the edge of a pane samples one
      // texel and lands wholly on one side, so the boundary always leaves a rim of half-key-coloured
      // faces on the body — the purple smear around the 911's greenhouse. Pushing that rim into the
      // glass costs a millimetre of pane and removes the fringe entirely.
      if (key && glassIdx.length && opts.grow !== 0) {
        const onGlass = new Set()
        for (const v of glassIdx) onGlass.add(v)
        const kept = [], moved = []
        for (let t = 0; t < bodyIdx.length; t += 3) {
          const tri = [bodyIdx[t], bodyIdx[t + 1], bodyIdx[t + 2]]
          // A body triangle touching two glass vertices is on the seam, not on the body.
          const touch = tri.filter((v) => onGlass.has(v)).length
          ;(touch >= 2 ? moved : kept).push(...tri)
        }
        if (moved.length) {
          // Not `push(...kept)` — spreading a few hundred thousand indices blows the call stack.
          bodyIdx.length = 0
          for (const v of kept) bodyIdx.push(v)
          for (const v of moved) glassIdx.push(v)
          picked += moved.length / 3
        }
      }

      if (!glassIdx.length) continue

      const Ctor = idx.getArray().constructor
      idx.setArray(new Ctor(bodyIdx))

      // DESPILL THE KEY OUT OF THE BODY TEXTURE. Even after the grow, TRELLIS's own texture
      // filtering bleeds key colour a few texels into the paint, and on a dark car that reads as
      // purple haze across the roof and pillars. This is the same clamp the chroma despill uses,
      // applied to the baked map instead of the photograph, and it only touches texels where the
      // key actually dominates, so real paint is untouched.
      if (key && opts.despillBody !== false) {
        const src2 = path.join(tmpDir, 'body.png')
        const out2 = path.join(tmpDir, 'body-clean.png')
        writeFileSync(src2, Buffer.from(tex.getImage()))
        // Per-channel, the way the chroma despill does it: `-fx` cannot build a colour in that
        // position (`NewUserSymbol 'rgb'`), so each key clamps its own dominant channels down to
        // the channel it is beating.
        const DESPILL = {
          magenta: ['RB', 'min(u.r,u.b)-u.g>0.06 ? u.g : u'],
          blue:    ['B',  'u.b-max(u.r,u.g)>0.06 ? max(u.r,u.g) : u'],
          red:     ['R',  'u.r-max(u.g,u.b)>0.06 ? max(u.g,u.b) : u'],
          green:   ['G',  'u.g-max(u.r,u.b)>0.06 ? max(u.r,u.b) : u'],
          cyan:    ['GB', 'min(u.g,u.b)-u.r>0.06 ? u.r : u'],
        }[opts.glassKey]
        magick([src2, '-channel', DESPILL[0], '-fx', DESPILL[1], '+channel', out2])
        tex.setImage(new Uint8Array(readFileSync(out2)))
        rmSync(src2, { force: true }); rmSync(out2, { force: true })
      }

      const glassMat = doc.createMaterial('glass')
        .setBaseColorFactor(debug ? [1, 0, 1, 1] : [0.62, 0.68, 0.72, 1])
        .setMetallicFactor(0)
        .setRoughnessFactor(debug ? 0.9 : 0.06)
        // No baseColorTexture on purpose. The baked glazing IS the mess we are replacing; keeping
        // it would tint the new glass with reconstructed interior smear.
        .setDoubleSided(true)
      if (!debug) {
        glassMat.setExtension('KHR_materials_transmission',
          transmission.createTransmission().setTransmissionFactor(1))
        glassMat.setExtension('KHR_materials_ior', ior.createIOR().setIOR(1.5))
        glassMat.setExtension('KHR_materials_volume',
          volume.createVolume().setThicknessFactor(0.01).setAttenuationDistance(0.6)
            .setAttenuationColor([0.7, 0.78, 0.8]))
      }

      const glassIndices = doc.createAccessor().setArray(new Ctor(glassIdx))
        .setBuffer(root.listBuffers()[0])
      const glassPrim = doc.createPrimitive()
        .setIndices(glassIndices)
        .setMaterial(glassMat)
      // Share the vertex accessors: the glass is the same shell, just different triangles.
      for (const name of prim.listSemantics()) glassPrim.setAttribute(name, prim.getAttribute(name))
      mesh.addPrimitive(glassPrim)
    }
  }
  rmSync(tmpDir, { recursive: true, force: true })
  await io.write(out, doc)
  return { picked, total, share: +(100 * picked / (total || 1)).toFixed(2) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1] }
  const id = flag('id')
  if (!id) { console.error('usage: glass.mjs --id <id> [--luma 0.22] [--min-height 0.40] [--max-up 0.86] [--roof-band 0.85] [--debug]'); process.exit(1) }
  const debug = argv.includes('--debug')
  // READ THE KEY FROM meta.json. Without this the CLI silently fell back to the old heuristic and
  // reported 42% of a black car as glass — which is the very failure the keyed colour replaces, and
  // it looked like a result rather than a fallback.
  const metaPath = path.join(LIB, 'out', id, 'meta.json')
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {}
  const src = path.join(LIB, 'out', id, `${id}.glb`)
  if (!existsSync(src)) { console.error(`no raw reconstruction at ${src}`); process.exit(1) }
  const out = path.join(LIB, 'out', id, `${id}-glass${debug ? '-debug' : ''}.glb`)
  const glassKey = flag('key', meta.glassKey ?? null)
  if (!glassKey) console.warn('  ! no glassKey in meta — falling back to the heuristic, which does not port')
  const r = await separateGlass(src, out, {
    glassKey,
    luma: Number(flag('luma', 0.22)),
    minHeight: Number(flag('min-height', 0.40)),
    maxUp: Number(flag('max-up', 0.86)),
    roofBand: Number(flag('roof-band', 0.85)),
    debug,
  })
  console.log(`${path.basename(out)}  ${r.picked}/${r.total} triangles as glass (${r.share}%) via ${glassKey ?? 'heuristic'}`)
}
