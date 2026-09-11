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
// Attach the template instead and it has a shape to fill.
//
// Nothing is cut out of them. Asking for artwork with holes in it — black circles where the wheel
// and buttons go, a black rectangle where the screen goes — is a hard thing to ask and a worse
// thing to get slightly wrong, and it confused every generator it was tried on. The cabinet draws
// its own wheel, buttons and screen as geometry standing on top of the artwork instead, so a panel
// is a plain rectangle of art and nothing has to line up.
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

/**
 * One per panel: the size to draw at, and any holes the artwork has to leave alone. Sizes are
 * generous — a generator asked to match a 1600-wide template will not hand back 1600 wide, but the
 * *shape* survives, and shape is the whole point.
 */
const TEMPLATES = {
  marquee: { w: 1600, h: 900, what: 'the lit sign on top; logo and tagline, edge to edge' },
  side: { w: 900, h: 1600, what: 'side art — one tall scene; use it for both side-left and side-right' },
  panel: { w: 2100, h: 900, what: 'the control deck seen from above; the cabinet puts the wheel and buttons on top' },
  bezel: { w: 1600, h: 1200, what: 'the surround; the cabinet puts the screen on top of the middle of it' },
  attract: { w: 1600, h: 1200, what: 'what the screen shows before the game loads' },
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
  'side-left': { x: 1272, y: 128, w: 340, h: 604, label: 'SIDE — LEFT' },
  'side-right': { x: 1644, y: 128, w: 340, h: 604, label: 'SIDE — RIGHT' },
  bezel: { x: 1272, y: 820, w: 560, h: 420, label: 'BEZEL' },
}

function drawSheet() {
  const args = ['-size', `${SHEET.w}x${SHEET.h}`, `xc:${FIELD}`]
  for (const s of Object.values(SLOTS)) {
    // The slot itself, a touch lighter than the field so its edges are unmistakable.
    args.push('-fill', '#8f8f8f', '-stroke', 'none', '-draw', `rectangle ${s.x},${s.y} ${s.x + s.w},${s.y + s.h}`)
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
  execFileSync('magick', ['-size', `${t.w}x${t.h}`, `xc:${FIELD}`, file])
  alsoInExt(file)
  console.log(`${path.relative(ROOT, file)}  ${t.w}×${t.h} (${(t.w / t.h).toFixed(2)}:1) — ${t.what}`)
}

console.log(`\nCopies are in ext/ as well, which is where the art goes in and out.
Attach sheet.png to fill a whole cabinet in one go, or a single panel's template to
redo one face. Either way, send a picture of the art to match with it. See apps/arcade/ART.md.`)
