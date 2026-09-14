#!/usr/bin/env node
// Turn drawn frames into something the game can wear.
//
//   node scripts/pack-frames.mjs ext/art/kestrel kestrel
//   node scripts/pack-frames.mjs ext/art/kestrel kestrel --height 90 --contact
//
// The generator draws one animation at a time, six frames to a sheet, with the feet on a common
// line and the stance on a common vertical. The cutter turns that sheet into PNGs. This turns those
// PNGs into `apps/fighter/public/assets/crown/chars/<id>/{atlas.png,frames.json}`, which is what
// `src/view/Sprites.ts` reads — the same shape the ROM rip produces, so drawn and ripped characters
// are interchangeable and the renderer cannot tell which it has.
//
// THE COMMON BASELINE IS THE WHOLE INPUT CONTRACT. Every frame of one animation must be the same
// canvas size, with the fighter standing on the same line and centred on the same vertical. That is
// all this needs to compute an anchor, and an anchor is what stops an animation wandering around
// the screen as it plays. Frames are then trimmed to their own alpha, so a sweep may be wide and
// short and a jab tall and narrow — the anchor puts each one back where it belongs.
//
//   <root>/idle/*.png          one directory per animation, frames in name order
//   <root>/walk-fwd/*.png
//   <root>/pack.json           optional: floorY, anchorX, fps, loop, aliases
//
// `pack.json` is worth one line even when nothing else needs saying:
//
//   { "floorY": 582, "anchorX": 318 }
//
// `floorY` is the canvas row the feet stand on — the row the anchor lands on, not the first empty
// row beneath it — and `anchorX` the column the stance is centred on. The template draws both, so
// saying where they are makes the anchor exact rather than inferred. For the `cycle` sheet those
// are `boxHeight * (1 - GROUND)` and `boxWidth / 2`: on the 2048x1536 sheet the generator returns,
// a box is 635x676 and the line is row 582, column 318. Without them the floor is taken
// to be the lowest pixel anything in that animation puts down and the centre to be the middle of the
// canvas, which is right for a fighter standing on the line and wrong for one whose foot dips below
// it. Either can be given per animation: `{ "floorY": { "crouch": 760 } }`.
//
// A flat directory of `<anim>-<n>.png` works too, for a generator that would rather not make
// directories.
//
// SCALE. Draw big; this brings it down. A fighter on the arcade screen is about ninety pixels tall
// and the game draws one sprite pixel to one screen pixel, so a five-hundred-pixel drawing has to
// come down by the same factor everywhere or the character changes size when they crouch. `--height`
// is the standing height to aim at, measured off `idle` and applied to every animation of that
// character. The factor lands in `frames.json` as `pixelScale`, so the masters stay the truth and
// this can be redone at another size whenever the renderer wants one.

import sharp from 'sharp'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_ROOT = path.join(ROOT, 'apps/fighter/public/assets/crown/chars')
const SHOTS = path.join(ROOT, 'shots')

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)
const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1]?.startsWith('--') && flag(argv[i - 1].slice(2)) === a))
const [inDir, charId] = positional
if (!inDir || !charId) {
  console.error(`usage: node scripts/pack-frames.mjs <frames-dir> <character-id> [--height 90] [--out <dir>] [--contact]

  <frames-dir>/<animation>/*.png   one directory per animation, or flat <animation>-<n>.png
  --height N   standing height to scale the whole character to, measured off its idle (default: no scaling)
  --contact    also write a labelled contact sheet to shots/`)
  process.exit(1)
}

const SRC = path.resolve(ROOT, inDir)
const OUT = flag('out') ? path.resolve(ROOT, flag('out')) : path.join(OUT_ROOT, charId)
const TARGET_H = flag('height') ? Number(flag('height')) : null

// --- gather ------------------------------------------------------------------------------------

const settings = existsSync(path.join(SRC, 'pack.json'))
  ? JSON.parse(readFileSync(path.join(SRC, 'pack.json'), 'utf8'))
  : {}

/** Numbers inside names sort as numbers, so frame 10 comes after frame 9. */
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

function collect() {
  const anims = new Map()
  const entries = readdirSync(SRC, { withFileTypes: true })
  for (const e of entries.filter((e) => e.isDirectory()).sort((a, b) => natural(a.name, b.name))) {
    const files = readdirSync(path.join(SRC, e.name)).filter((f) => /\.(png|webp)$/i.test(f)).sort(natural)
    if (files.length) anims.set(e.name, files.map((f) => path.join(SRC, e.name, f)))
  }
  // flat form: <anim>-<n>.png
  const loose = entries.filter((e) => e.isFile() && /\.(png|webp)$/i.test(e.name)).map((e) => e.name).sort(natural)
  for (const f of loose) {
    const m = /^(.*?)-(\d+)\.(png|webp)$/i.exec(f)
    if (!m) continue
    const anim = m[1]
    if (!anims.has(anim)) anims.set(anim, [])
    anims.get(anim).push(path.join(SRC, f))
  }
  return anims
}

/**
 * The alpha bounding box of one image, ignoring specks.
 *
 * An untrimmed keyed frame is mostly background, and a key rarely comes back perfect — a few
 * survivors in a corner would stretch the box across the whole canvas and move the anchor with it.
 * So a row or column has to carry at least `MIN_RUN` opaque pixels to count as part of the figure.
 */
const MIN_RUN = 3
async function measure(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h } = info
  const rows = new Int32Array(h)
  const cols = new Int32Array(w)
  let opaque = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 8) continue
      rows[y]++
      cols[x]++
      opaque++
    }
  }
  let x0 = -1, x1 = -1, y0 = -1, y1 = -1
  for (let x = 0; x < w; x++) if (cols[x] >= MIN_RUN) { if (x0 < 0) x0 = x; x1 = x }
  for (let y = 0; y < h; y++) if (rows[y] >= MIN_RUN) { if (y0 < 0) y0 = y; y1 = y }
  return {
    file,
    w, h,
    coverage: opaque / (w * h),
    box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
  }
}

// --- pack --------------------------------------------------------------------------------------

const anims = collect()
if (!anims.size) {
  console.error(`nothing to pack in ${path.relative(ROOT, SRC)} — expected <animation>/*.png`)
  process.exit(1)
}

const measured = new Map()
for (const [anim, files] of anims) {
  const frames = []
  for (const f of files) frames.push(await measure(f))
  const drawn = frames.filter((f) => f.box)
  if (!drawn.length) { console.warn(`  ! ${anim}: every frame is empty`); continue }
  const sizes = new Set(drawn.map((f) => `${f.w}x${f.h}`))
  if (sizes.size > 1) {
    console.warn(`  ! ${anim}: frames are ${[...sizes].join(', ')} — they must share a canvas for the baseline to mean anything; using each frame's own feet`)
  }
  measured.set(anim, { frames: drawn, sharedCanvas: sizes.size === 1 })
}

// One scale for the whole character, off the idle, so a crouch does not come out a different size.
let scale = 1
if (TARGET_H) {
  const ref = measured.get('idle') ?? measured.values().next().value
  const standing = Math.max(...ref.frames.map((f) => f.box.h))
  scale = TARGET_H / standing
  console.log(`scale ${(scale * 100).toFixed(1)}% — idle stands ${standing}px, target ${TARGET_H}px`)
}

const items = []
const drift = []
for (const [anim, { frames, sharedCanvas }] of measured) {
  // The floor is the lowest pixel anyone in this animation puts down; the stance vertical is the
  // middle of the canvas unless pack.json says otherwise.
  const per = (v) => (v == null ? null : typeof v === 'object' ? v[anim] ?? null : v)
  const floor = per(settings.floorY) ?? (sharedCanvas ? Math.max(...frames.map((f) => f.box.y + f.box.h)) : null)
  const anchorX = per(settings.anchorX) ?? (sharedCanvas ? frames[0].w / 2 : null)
  for (const [i, f] of frames.entries()) {
    const bottom = floor ?? f.box.y + f.box.h
    const centre = anchorX ?? f.box.x + f.box.w / 2
    let img = sharp(f.file).ensureAlpha().extract({ left: f.box.x, top: f.box.y, width: f.box.w, height: f.box.h })
    let w = f.box.w, h = f.box.h
    let ax = centre - f.box.x, ay = bottom - f.box.y
    if (scale !== 1) {
      w = Math.max(1, Math.round(w * scale))
      h = Math.max(1, Math.round(h * scale))
      ax *= scale
      ay *= scale
      img = img.resize(w, h, { kernel: 'lanczos3', fit: 'fill' })
    }
    drift.push({ anim, i, below: (f.box.y + f.box.h) - bottom })
    items.push({
      anim,
      name: `${anim}-${i}`,
      data: await img.raw().toBuffer(),
      w, h,
      ax: Math.round(ax),
      ay: Math.round(ay),
    })
  }
}

// shelf packing, tallest first
const sorted = [...items].sort((a, b) => b.h - a.h || b.w - a.w)
const maxW = Number(flag('atlas-width', '2048'))
let x = 1, y = 1, shelf = 0, width = 0
for (const it of sorted) {
  if (x + it.w + 1 > maxW && x > 1) { x = 1; y += shelf + 1; shelf = 0 }
  it.px = x; it.py = y
  x += it.w + 1
  shelf = Math.max(shelf, it.h)
  width = Math.max(width, x)
}
const size = { w: width + 1, h: y + shelf + 2 }

mkdirSync(OUT, { recursive: true })
await sharp({ create: { width: size.w, height: size.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(items.map((it) => ({ input: it.data, raw: { width: it.w, height: it.h, channels: 4 }, left: it.px, top: it.py })))
  .png()
  .toFile(path.join(OUT, 'atlas.png'))

const LOOPS = /^(idle|walk-|crouch-idle|dizzy)/
const frames = {}
const animsOut = {}
for (const it of items) frames[it.name] = { x: it.px, y: it.py, w: it.w, h: it.h, ax: it.ax, ay: it.ay }
for (const anim of measured.keys()) {
  const names = items.filter((i) => i.anim === anim).map((i) => i.name)
  animsOut[anim] = {
    frames: names,
    fps: settings.fps?.[anim] ?? (LOOPS.test(anim) ? 12 : 15),
    loop: settings.loop?.[anim] ?? LOOPS.test(anim),
  }
}
for (const [alias, of] of Object.entries(settings.alias ?? {})) {
  if (animsOut[of]) animsOut[alias] = { ...animsOut[of] }
}

writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify({
  id: charId,
  source: path.relative(ROOT, SRC),
  pixelScale: Number(scale.toFixed(4)),
  atlas: 'atlas.png',
  atlasSize: size,
  facing: 'right',
  anchor: 'ax, ay = the fighter position this pose was drawn around: the floor between the feet',
  frames,
  anims: animsOut,
}, null, 1))

console.log(`${charId}: ${items.length} frames in ${measured.size} animations, atlas ${size.w}x${size.h} -> ${path.relative(ROOT, OUT)}`)
for (const [anim, { frames: f, sharedCanvas }] of measured) {
  // How far each frame's lowest pixel sits from the line it was supposed to stand on. A few pixels
  // is a heel or a shadow of a shoe; twenty is the baseline having slipped, and it will show up in
  // the game as the character sinking into the floor on that frame.
  const d = drift.filter((x) => x.anim === anim).map((x) => x.below)
  const worst = d.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)
  const cover = (f.reduce((s, x) => s + x.coverage, 0) / f.length * 100).toFixed(0)
  const note = !sharedCanvas
    ? '  (no shared canvas — anchors are per-frame guesses)'
    : Math.abs(worst) > 12 ? `  ! a frame stands ${worst > 0 ? worst + 'px below' : -worst + 'px above'} the floor line` : ''
  console.log(`  ${anim.padEnd(14)} ${String(f.length).padStart(2)} frames  ${String(cover).padStart(2)}% ink${note}`)
}

if (has('contact')) {
  const pad = 6, labelH = 12, maxCW = 1800
  let cx = pad, cy = pad, rowH = 0, W = 0
  for (const it of items) {
    if (cx + it.w + pad > maxCW && cx > pad) { cx = pad; cy += rowH + pad; rowH = 0 }
    it.cx = cx; it.cy = cy
    cx += Math.max(it.w, 30) + pad
    rowH = Math.max(rowH, it.h + labelH)
    W = Math.max(W, cx)
  }
  const H = cy + rowH + pad
  const bg = Buffer.alloc(W * H * 4)
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const v = ((xx >> 3) + (yy >> 3)) & 1 ? 0x5a : 0x46
    const i = (yy * W + xx) * 4
    bg[i] = v; bg[i + 1] = v; bg[i + 2] = v; bg[i + 3] = 255
  }
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
  const layers = items.map((it) => ({ input: it.data, raw: { width: it.w, height: it.h, channels: 4 }, left: it.cx, top: it.cy + labelH }))
  for (const it of items) {
    svg += `<text x="${it.cx}" y="${it.cy + 9}" font-family="monospace" font-size="9" fill="#fff">${it.name}</text>`
    const ay = it.cy + labelH + it.ay, ax = it.cx + it.ax
    svg += `<line x1="${it.cx}" x2="${it.cx + it.w}" y1="${ay}" y2="${ay}" stroke="#0f0" stroke-width="1"/>`
    svg += `<line x1="${ax}" x2="${ax}" y1="${it.cy + labelH}" y2="${it.cy + labelH + it.h}" stroke="#f0f" stroke-width="1"/>`
  }
  svg += '</svg>'
  layers.push({ input: Buffer.from(svg), left: 0, top: 0 })
  mkdirSync(SHOTS, { recursive: true })
  await sharp(bg, { raw: { width: W, height: H, channels: 4 } }).composite(layers).png().toFile(path.join(SHOTS, `pack-${charId}.png`))
  console.log(`  contact sheet: shots/pack-${charId}.png`)
}
