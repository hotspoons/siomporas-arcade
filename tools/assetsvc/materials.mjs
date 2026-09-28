// Generating a tileable material: a prompt in, three maps out.
//
// Rich, 2026-09-28: "we need a generator form, not an upload form for textures, this is all wrong.
// Need a detail panel for each texture where we can capture prompts and edit them and regenerate
// textures (don't blow away old copies until an explicit save operation happens!)"
//
// A PORT OF tools/surfaces/gen.py, not a new idea. That script has been making the road surfaces
// this game drives on for weeks and its three decisions are the ones worth keeping:
//
//   TILEABILITY IS MADE, NOT ASKED FOR. flux does not reliably return a seamless tile however
//   nicely you ask, so the image is rolled by half in both axes — which moves its discontinuous
//   outer edges to the middle and makes the OUTSIDE continuous — and the resulting cross-shaped
//   seam is blended out over a band. For a texture whose statistics are stationary (asphalt,
//   gravel, brick) this is invisible; it smears one with a single large feature, which is a fact
//   about the prompt and is said in the UI rather than worked around here.
//
//   THE NORMAL COMES FROM THE ALBEDO, treating dark as low. Right for aggregate, pitting and
//   mortar courses; wrong for white paint, which these textures do not contain. The gradients wrap
//   around the edges so the normal map tiles as well as the colour does.
//
//   ROUGHNESS IS INVERTED, STRETCHED ALBEDO — the crowns of the aggregate are the polished parts.
//
// WHAT IS NOT PORTED: the macro map and the variant library. Those belong to the road surface
// pipeline, which composites several scales; a material in this catalog is one tile.
//
// NOTHING HERE WRITES OVER A LIVE FILE. Everything lands in the material's `draft/` directory and
// stays there until somebody commits it — see `commitDraft`.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

/** Seam blend width in pixels, at 1024. The same 96 the road surfaces use. */
const BAND = 96

/**
 * What every texture prompt says, whatever the material is.
 *
 * Straight down, flat light, no objects, edge to edge. Each of those is a failure mode seen in the
 * road set: a camera at an angle gives a texture with perspective baked into it, a directional key
 * bakes a shadow that then lights the whole world wrongly, and anything recognisable in frame
 * becomes a thing that repeats every two metres across a building.
 */
export const TEXTURE_COMMON =
  'Top-down orthographic photograph, camera pointing straight down, uniform flat overcast lighting, '
  + 'no shadows, no objects, no people, edge to edge texture only, photorealistic, sharp, filling the frame'

/** The prompt actually sent: what the person wrote, plus the rules that make it a texture. */
export function texturePrompt(subject, metresPerTile) {
  const size = metresPerTile ? `, ${metresPerTile} metre square` : ''
  return `${String(subject ?? '').trim()}. ${TEXTURE_COMMON}${size}`
}

/**
 * Roll by half and blend the cross seam away.
 *
 * On the seam the ORIGINAL is used, because it is continuous there; away from it the rolled image,
 * whose outer edges are the original's continuous middle. The result wraps — see the weight below
 * for the one place that rule has to be overridden.
 */
async function makeTileable(buf) {
  const img = sharp(buf).removeAlpha()
  const { width: w, height: h } = await img.metadata()
  const a = await img.raw().toBuffer()
  const hw = Math.floor(w / 2)
  const hh = Math.floor(h / 2)
  const out = Buffer.alloc(a.length)
  const band = Math.max(1, Math.round((BAND * Math.min(w, h)) / 1024))
  for (let y = 0; y < h; y++) {
    const dy = Math.abs(y - hh)
    const ry = (y + hh) % h
    for (let x = 0; x < w; x++) {
      const dx = Math.abs(x - hw)
      /*
       * 0 ON THE SEAM, 1 AWAY FROM IT — AND 1 AGAIN AT THE OUTER EDGE.
       *
       * That second clause is not in the Python this is ported from, and it is a real bug there.
       * `min(dy, dx)` is zero along the WHOLE centre row and the whole centre column, so the
       * middle row of the output was taken from the original — including its left and right
       * edges, which are exactly the discontinuity the roll exists to hide. On a stationary
       * texture nobody sees one row; on anything with a gradient across it, that row is a hard
       * line. Forcing the outer band back to the rolled image costs nothing: out there the rolled
       * image IS continuous, which is the whole point of having rolled it.
       */
      const edge = Math.min(x, w - 1 - x, y, h - 1 - y)
      const wgt = Math.min(1, Math.max(Math.min(dy, dx) / band, 1 - edge / band))
      const rx = (x + hw) % w
      const i = (y * w + x) * 3
      const j = (ry * w + rx) * 3
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(wgt * a[j + c] + (1 - wgt) * a[i + c])
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer()
}

/**
 * A tangent-space normal map and a roughness map, from the colour.
 *
 * Gradients are taken with wrap-around indexing so both maps tile exactly as the albedo does — a
 * normal map with a discontinuous edge shows as a hard line of wrong lighting every tile, which is
 * more obvious than a colour seam and much harder to attribute.
 */
async function derive(albedo, strength = 2.5) {
  const grey = sharp(albedo).greyscale()
  const { width: w, height: h } = await grey.metadata()
  const blurred = await sharp(await grey.toBuffer()).blur(1.2).raw().toBuffer()
  let lo = 255
  let hi = 0
  for (const v of blurred) { if (v < lo) lo = v; if (v > hi) hi = v }
  const span = Math.max(1, hi - lo)
  const at = (x, y) => (blurred[((y + h) % h) * w + ((x + w) % w)] - lo) / span

  const n = Buffer.alloc(w * h * 3)
  const r = Buffer.alloc(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * strength * 20
      const gy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * strength * 20
      // +Y up, the OpenGL convention three.js expects
      const len = Math.hypot(-gx, gy, 1)
      const i = (y * w + x) * 3
      n[i] = Math.round(((-gx / len) * 0.5 + 0.5) * 255)
      n[i + 1] = Math.round(((gy / len) * 0.5 + 0.5) * 255)
      n[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255)
      // dark is rough: the polished crowns of the aggregate are the light parts
      r[y * w + x] = Math.round(Math.min(1, Math.max(0, 0.55 + 0.4 * (1 - at(x, y)))) * 255)
    }
  }
  return {
    normal: await sharp(n, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(),
    roughness: await sharp(r, { raw: { width: w, height: h, channels: 1 } }).blur(2).jpeg({ quality: 90 }).toBuffer(),
  }
}

/**
 * Draw a material and derive its maps, into the material's `draft/` directory.
 *
 * @param {object} o
 * @param {string} o.dir           the surfaces directory
 * @param {string} o.id            the material
 * @param {string} o.subject       what the person wrote
 * @param {number} o.metresPerTile
 * @param {number} [o.seed]
 * @param {(s: object) => void} [o.report]
 * @param {{generate: Function, id: string}} o.model  the image model, from the registry
 */
export async function generateDraft({ dir, id, subject, metresPerTile, seed, size = '1024x1024', model, report = () => {} }) {
  const prompt = texturePrompt(subject, metresPerTile)
  report({ state: 'drawing', model: model.id })
  const drawn = await model.generate({ prompt, size, seed })
  report({ state: 'tiling' })
  const albedo = await makeTileable(drawn.png)
  report({ state: 'deriving' })
  const { normal, roughness } = await derive(albedo)

  const draft = path.join(dir, id, 'draft')
  await rm(draft, { recursive: true, force: true })
  await mkdir(draft, { recursive: true })
  await writeFile(path.join(draft, 'albedo.jpg'), albedo)
  await writeFile(path.join(draft, 'normal.png'), normal)
  await writeFile(path.join(draft, 'roughness.jpg'), roughness)
  const meta = {
    prompt: subject,
    sentPrompt: prompt,
    seed: drawn.meta?.seed ?? seed ?? null,
    model: model.id,
    metres_per_tile: metresPerTile,
    seconds: drawn.seconds,
    at: new Date().toISOString(),
  }
  await writeFile(path.join(draft, 'draft.json'), JSON.stringify(meta, null, 1))
  return { ...meta, files: ['albedo.jpg', 'normal.png', 'roughness.jpg'], bytes: albedo.length + normal.length + roughness.length }
}

/** What is waiting to be accepted, if anything. */
export async function readDraft(dir, id) {
  const f = path.join(dir, id, 'draft', 'draft.json')
  if (!existsSync(f)) return null
  try {
    return JSON.parse(await readFile(f, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Accept the draft: it becomes the material, and what it replaced is kept.
 *
 * "don't blow away old copies until an explicit save operation happens" — so this is the explicit
 * operation, and even here the previous maps are moved to `previous/` rather than deleted. A
 * regeneration that turns out worse than what it replaced is the normal case, not the rare one.
 */
export async function commitDraft(dir, id) {
  const home = path.join(dir, id)
  const draft = path.join(home, 'draft')
  const meta = await readDraft(dir, id)
  if (!meta) throw Object.assign(new Error(`${id} has no draft to save`), { status: 404 })
  const kept = path.join(home, 'previous')
  await rm(kept, { recursive: true, force: true })
  await mkdir(kept, { recursive: true })
  for (const f of await readdir(home).catch(() => [])) {
    if (f === 'draft' || f === 'previous') continue
    await rename(path.join(home, f), path.join(kept, f)).catch(() => {})
  }
  for (const f of await readdir(draft)) {
    if (f === 'draft.json') continue
    await rename(path.join(draft, f), path.join(home, f))
  }
  await rm(draft, { recursive: true, force: true })
  return { id, albedo: 'albedo.jpg', normal: 'normal.png', roughness: 'roughness.jpg', prompt: meta.prompt, seed: meta.seed }
}

/** Throw the draft away. The live files were never touched, so there is nothing else to undo. */
export async function discardDraft(dir, id) {
  await rm(path.join(dir, id, 'draft'), { recursive: true, force: true })
  return { id, discarded: true }
}
