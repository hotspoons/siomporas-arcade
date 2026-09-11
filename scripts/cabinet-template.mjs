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
import { ASPECT as SIDE_ASPECT, OUTLINE as SIDE_PROFILE } from './lib/flank.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'apps/arcade/art-templates')

const FIELD = '#7a7a7a'
const SLOT = '#8f8f8f'

/** The outline drawn at its own proportions, as large as fits and centred, inside a box. */
function profile(x, y, w, h, flank) {
  const pw = Math.min(w, h * SIDE_ASPECT)
  const ph = pw / SIDE_ASPECT
  const ox = x + (w - pw) / 2
  const oy = y + (h - ph) / 2
  const pts = SIDE_PROFILE.map(([u, v]) => {
    const uu = flank === 'side-left' ? 1 - u : u
    return `${Math.round(ox + uu * pw)},${Math.round(oy + v * ph)}`
  })
  return ['-fill', SLOT, '-stroke', 'none', '-draw', `polygon ${pts.join(' ')}`]
}

/**
 * One per panel: the size to draw at, and any holes the artwork has to leave alone. Sizes are
 * generous — a generator asked to match a 1600-wide template will not hand back 1600 wide, but the
 * *shape* survives, and shape is the whole point.
 */
const TEMPLATES = {
  marquee: { w: 1600, h: 900, what: 'the lit sign on top; logo and tagline, edge to edge' },
  'side-left': { w: 900, h: Math.round(900 / SIDE_ASPECT), shape: 'side-left', what: "the left flank — the board's outline, front of the machine at the right" },
  'side-right': { w: 900, h: Math.round(900 / SIDE_ASPECT), shape: 'side-right', what: "the right flank — the same board mirrored, front at the left" },
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
  for (const [name, s] of Object.entries(SLOTS)) {
    // The slot itself, a touch lighter than the field so its edges are unmistakable — except the two
    // flanks, which are drawn as the shape of a cabinet's side rather than as a rectangle. The slot
    // is still cut out whole, and the geometry crops to the outline, so a generator that paints past
    // it loses only what was never going to be on the machine anyway.
    if (name.startsWith('side')) args.push(...profile(s.x, s.y, s.w, s.h, name))
    else args.push('-fill', SLOT, '-stroke', 'none', '-draw', `rectangle ${s.x},${s.y} ${s.x + s.w},${s.y + s.h}`)
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

/**
 * ext/ is the scratch directory art comes and goes through, so the sheet lives there too — only the
 * sheet. The per-panel templates stay in art-templates/, where they are out of the way of the
 * artwork; one cabinet at a time is the workflow, and a directory of six blanks to pick through is
 * not a help.
 */
function alsoInExt(file) {
  const ext = path.join(ROOT, 'ext')
  if (!existsSync(ext)) return
  copyFileSync(file, path.join(ext, path.basename(file)))
}
alsoInExt(path.join(OUT, 'sheet.png'))

for (const [name, t] of Object.entries(TEMPLATES)) {
  const file = path.join(OUT, `${name}.png`)
  const shape = t.shape ? profile(0, 0, t.w, t.h, t.shape) : []
  execFileSync('magick', ['-size', `${t.w}x${t.h}`, `xc:${FIELD}`, ...shape, file])
  console.log(`${path.relative(ROOT, file)}  ${t.w}×${t.h} (${(t.w / t.h).toFixed(2)}:1) — ${t.what}`)
}

console.log(`\nsheet.png is copied into ext/ as well, which is where the art goes in and out.
Attach it to fill a whole cabinet in one go, or one of the panel templates above to
redo a single face. Either way, send a picture of the art to match with it. See apps/arcade/ART.md.`)
