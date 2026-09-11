#!/usr/bin/env node
// Draw the blank layout templates you hand an image generator alongside a reference picture.
//
//   node scripts/cabinet-template.mjs          # writes apps/arcade/art-templates/*.png + sheet.png
//
// Two shapes of template. One per panel, for when you want to redo a single face — and one sheet
// with every panel on it, labelled, for asking a generator to fill the whole cabinet in one go.
// These models return several megapixels whatever you ask for, so there is room for all of it.
//
// The sheet's slots are written to sheet.json in fractions of the canvas, because *we* drew it: the
// generator hands back a different pixel size, and every panel can still be cut out by proportion
// with no detection, no magenta, and nothing to eyeball.
//
// These exist because asking a chat image generator for "roughly 21:9" gets you 16:9 and a shrug.
// Attach the template instead and it has something concrete to fill: the right shape, and the
// black holes exactly where the cabinet needs them — the wheel and buttons cut out of a control
// deck, the screen out of a bezel. Whatever it draws around those lands on the cabinet correctly.
//
// The field is mid grey on purpose. White reads as paper and gets a border drawn round it; black
// reads as part of the art. Grey reads as nothing, which is what it is.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'apps/arcade/art-templates')

const FIELD = '#7a7a7a'
const HOLE = '#000000'

/**
 * One per panel: the size to draw at, and any holes the artwork has to leave alone. Sizes are
 * generous — a generator asked to match a 1600-wide template will not hand back 1600 wide, but the
 * *shape* survives, and shape is the whole point.
 */
const TEMPLATES = {
  marquee: { w: 1600, h: 900, draw: [], what: 'the lit sign on top; logo and tagline, edge to edge' },
  side: { w: 900, h: 1600, draw: [], what: 'side art; one tall scene, logo in the upper third' },
  panel: {
    w: 2100,
    h: 900,
    // Wheel left of centre, three buttons to the right of it, all at deck height.
    draw: [
      ['circle', 590, 450, 590, 180],
      ['circle', 1180, 450, 1180, 370],
      ['circle', 1380, 450, 1380, 370],
      ['circle', 1580, 450, 1580, 370],
    ],
    what: 'the control deck seen from above; the black circles are the wheel and buttons',
  },
  bezel: {
    w: 1600,
    h: 1200,
    // The screen: a 4:3 hole with the artwork running round it as a border.
    draw: [['rectangle', 288, 216, 1312, 984]],
    what: 'the surround; artwork frames the black rectangle, which is the screen',
  },
  attract: { w: 1600, h: 1200, draw: [], what: 'what the screen shows before the game loads' },
}

/**
 * The sheet: every panel laid out on one 4:3 canvas with a label above each. 4:3 because it is a
 * shape every generator offers, so what comes back is likely to have the same proportions as what
 * went in — which is what makes cutting it up by fractions work.
 *
 * Labels live in the gutters, never inside a slot, so whatever the generator does with them is
 * discarded when the slots are cut out.
 */
const SHEET = { w: 2048, h: 1536 }
const SLOTS = {
  marquee: { x: 64, y: 128, w: 1120, h: 630, label: 'MARQUEE' },
  panel: { x: 64, y: 856, w: 1120, h: 480, label: 'CONTROL PANEL' },
  side: { x: 1272, y: 128, w: 480, h: 853, label: 'SIDE ART' },
  bezel: { x: 1272, y: 1060, w: 560, h: 420, label: 'BEZEL' },
}

function drawSheet() {
  const args = ['-size', `${SHEET.w}x${SHEET.h}`, `xc:${FIELD}`]
  for (const [name, s] of Object.entries(SLOTS)) {
    // The slot itself, a touch lighter than the field so its edges are unmistakable.
    args.push('-fill', '#8f8f8f', '-stroke', 'none', '-draw', `rectangle ${s.x},${s.y} ${s.x + s.w},${s.y + s.h}`)
    // Its holes, in slot coordinates.
    for (const [kind, ...pts] of holesFor(name, s)) {
      args.push('-fill', HOLE, '-draw', `${kind} ${pts.join(',')}`)
    }
    args.push('-fill', '#1a1a1a', '-pointsize', '34', '-annotate', `+${s.x}+${s.y - 18}`, `${s.label}`)
  }
  const file = path.join(OUT, 'sheet.png')
  execFileSync('magick', [...args, file])
  const slots = Object.fromEntries(
    Object.entries(SLOTS).map(([name, s]) => [name, { x: s.x / SHEET.w, y: s.y / SHEET.h, w: s.w / SHEET.w, h: s.h / SHEET.h }]),
  )
  writeFileSync(path.join(OUT, 'sheet.json'), `${JSON.stringify({ canvas: SHEET, slots }, null, 2)}\n`)
  console.log(`${path.relative(ROOT, file)}  ${SHEET.w}×${SHEET.h} — every panel at once, labelled; slots in sheet.json`)
}

/** The black holes a slot needs, placed inside it. */
function holesFor(name, s) {
  if (name === 'panel') {
    const r = s.h * 0.3
    const y = s.y + s.h * 0.5
    return [
      ['circle', s.x + s.w * 0.26, y, s.x + s.w * 0.26, y - r],
      ['circle', s.x + s.w * 0.56, y, s.x + s.w * 0.56, y - r * 0.32],
      ['circle', s.x + s.w * 0.65, y, s.x + s.w * 0.65, y - r * 0.32],
      ['circle', s.x + s.w * 0.74, y, s.x + s.w * 0.74, y - r * 0.32],
    ].map((d) => d.map((v) => (typeof v === 'number' ? Math.round(v) : v)))
  }
  if (name === 'bezel') {
    const inset = { x: s.w * 0.18, y: s.h * 0.18 }
    return [['rectangle', Math.round(s.x + inset.x), Math.round(s.y + inset.y), Math.round(s.x + s.w - inset.x), Math.round(s.y + s.h - inset.y)]]
  }
  return []
}

mkdirSync(OUT, { recursive: true })
drawSheet()

/** ext/ is the scratch directory art comes and goes through, so the templates live there too. */
function alsoInExt(file) {
  const ext = path.join(ROOT, 'ext')
  if (!existsSync(ext)) return
  copyFileSync(file, path.join(ext, path.basename(file)))
}
alsoInExt(path.join(OUT, 'sheet.png'))

for (const [name, t] of Object.entries(TEMPLATES)) {
  const file = path.join(OUT, `${name}.png`)
  const args = ['-size', `${t.w}x${t.h}`, `xc:${FIELD}`, '-fill', HOLE, '-stroke', 'none']
  for (const [kind, ...pts] of t.draw) args.push('-draw', `${kind} ${pts.join(',')}`)
  args.push(file)
  execFileSync('magick', args)
  alsoInExt(file)
  console.log(`${path.relative(ROOT, file)}  ${t.w}×${t.h} (${(t.w / t.h).toFixed(2)}:1) — ${t.what}`)
}

console.log(`\nCopies are in ext/ as well, which is where the art goes in and out.
Attach sheet.png to fill a whole cabinet in one go, or a single panel's template to
redo one face. Either way, send a picture of the art to match with it. See apps/arcade/ART.md.`)
