#!/usr/bin/env node
// What a packed character actually looks like, animation by animation, standing on the floor.
//
//   node scripts/fighter-contact.mjs kestrel [out.png]
//
// A contact sheet of the *source* PNGs flatters everything: every cell is the same size and every
// figure fills it, so a pose drawn at twice the scale of its neighbours looks fine. This draws the
// packed result instead — each frame cut out of `atlas.png` and placed by its own anchor on a
// common floor line, the way the game will draw it — which is the only view in which a frame that
// is the wrong size, or standing in the air, or missing its head, is obvious.
//
// Read it the way the renderer does: every frame of a row should stand on the cyan line, and should
// be the same person at the same distance. A frame twice as wide as its neighbours is not a wider
// pose, it is a close-up that got packed as a fighter.

import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHARS = path.join(ROOT, 'apps/fighter/public/assets/crown/chars')

const id = process.argv[2]
if (!id) {
  console.error('usage: fighter-contact.mjs <character> [out.png]')
  console.error(`characters: ${fs.readdirSync(CHARS).join(', ')}`)
  process.exit(1)
}
const dir = path.join(CHARS, id)
const out = process.argv[3] ?? path.join(ROOT, `shots/contact-${id}.png`)

const j = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8'))
const atlas = path.join(dir, j.atlas)
const names = Object.keys(j.anims)

// Width tells you something only where the pose is not supposed to change shape. An attack's widest
// frame is the whole point of the attack — Ryu's fierce is 1.7x his own median and correct — but a
// standing or walking cycle that suddenly doubles in width is not a wider pose, it is a drawing at a
// different scale, and at 90px that reads as the camera jumping.
const STEADY = new Set(['idle', 'walk-fwd', 'walk-back', 'crouch', 'crouch-idle'])

// One cell per frame, tall enough for the tallest frame of the character plus the labels.
const tallest = Math.max(...Object.values(j.frames).map((f) => f.h))
const widest = Math.max(...Object.values(j.frames).map((f) => f.w))
const CELL = Math.max(90, widest + 10)
const ROW = tallest + 22
const PAD = 96
const cols = Math.max(...names.map((n) => j.anims[n].frames.length))
const W = PAD + CELL * cols
const H = ROW * names.length

const cuts = []
const svg = [`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`]
const warnings = []

for (const [r, name] of names.entries()) {
  const anim = j.anims[name]
  const top = r * ROW
  const floor = top + ROW - 6
  svg.push(`<text x="4" y="${top + ROW / 2}" font-family="monospace" font-size="13" fill="#fff">${name}</text>`)

  // The median width of the row is what "the same person at the same distance" looks like here.
  const widths = anim.frames.map((f) => j.frames[f]?.w ?? 0).filter(Boolean).sort((a, b) => a - b)
  const median = widths[Math.floor(widths.length / 2)] ?? 0

  for (const [i, f] of anim.frames.entries()) {
    const fr = j.frames[f]
    const left = PAD + i * CELL
    svg.push(`<line x1="${left}" y1="${floor}" x2="${left + CELL - 6}" y2="${floor}" stroke="#2ad8d8" stroke-width="1"/>`)
    if (!fr) {
      svg.push(`<text x="${left + 4}" y="${top + 16}" font-family="monospace" font-size="10" fill="#f66">${i}: MISSING ${f}</text>`)
      warnings.push(`${name}[${i}] ${f}: not in the atlas`)
      continue
    }
    const odd = STEADY.has(name) && median > 0 && fr.w > median * 1.4
    svg.push(
      `<text x="${left + 4}" y="${top + 14}" font-family="monospace" font-size="10" fill="${odd ? '#ff8' : '#8f8'}">` +
        `${i}: ${fr.w}x${fr.h}${odd ? ' ??' : ''}</text>`,
    )
    if (odd) warnings.push(`${name}[${i}] is ${fr.w} wide against a row median of ${median} — the same character drawn at a different scale?`)
    // Right for a body in the air, wrong for anything standing: the sheet is the place to tell.
    // Only for the cycles: an air normal or a kick that leaves the ground is meant to be up there.
    if (STEADY.has(name) && fr.ay > fr.h + 1) warnings.push(`${name}[${i}] draws ${fr.ay - fr.h}px clear of the floor — it will hover`)
    cuts.push({ fr, left: left + 4, top: floor - fr.ay })
  }
}
svg.push('</svg>')

fs.mkdirSync(path.dirname(out), { recursive: true })
const composite = await Promise.all(
  cuts.map(async (c) => ({
    input: await sharp(atlas).extract({ left: c.fr.x, top: c.fr.y, width: c.fr.w, height: c.fr.h }).png().toBuffer(),
    left: Math.round(c.left),
    top: Math.round(c.top),
  })),
)
await sharp({ create: { width: W, height: H, channels: 4, background: '#202028' } })
  .composite([...composite, { input: Buffer.from(svg.join('')), left: 0, top: 0 }])
  .png()
  .toFile(out)

console.log(`${out}  ${W}x${H}  ${names.length} animations, ${Object.keys(j.frames).length} frames`)
for (const w of warnings) console.log(`  ! ${w}`)
