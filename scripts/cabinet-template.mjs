#!/usr/bin/env node
// Draw the blank layout templates you hand an image generator alongside a reference picture.
//
//   node scripts/cabinet-template.mjs          # art-templates/*.png + sheet.png + sheet.json
//
// Two shapes of template. One sheet with every panel on it, labelled, for filling a whole cabinet in
// one go — and one per panel, for redoing a single face.
//
// Every slot is drawn at the *exact* shape the machine wants, out of scripts/lib/fit.mjs, which is
// the cabinet's own measurements. Asking a chat generator for "roughly 21:9" gets you 16:9 and a
// shrug; giving it a shape to fill gets you the shape, near enough.
//
// "Near enough" is the whole design here. A generator follows an outline the way a painter follows a
// reference, so nothing downstream depends on it being exact:
//
//   every slot is filled edge to edge, corner to corner — the prompt asks for the scene to run off
//   all four sides. What is cut out is the slot, so artwork that overshoots is trimmed and artwork
//   that falls short is the one thing that shows.
//   the guides inside a slot — the outline of a flank, the hole in a bezel — say where the machine
//   *is*, so that logos and faces land somewhere they will survive. They are drawn a shade off the
//   slot so they read as guidance rather than as edges to stop at.
//
// The field is mid grey on purpose. White reads as paper and gets a border drawn round it; black
// reads as part of the art. Grey reads as nothing, which is what it is — and it is what the cutter
// looks for when it goes hunting for the panels (see scripts/lib/sheet.mjs).

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BEZEL, DECK, FLANK, MARQUEE, SCREEN } from './lib/fit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'apps/arcade/art-templates')

const FIELD = '#7a7a7a'
const SLOT = '#8f8f8f'
/** The guides: a shade off the slot, so they are visible without reading as a boundary. */
const GUIDE = '#a2a2a2'
const GUIDE_DARK = '#6d6d6d'
const LABEL = '#1a1a1a'

/** One per panel: the shape the machine wants, and what is drawn inside it as guidance. */
const PANELS = {
  marquee: { aspect: MARQUEE, guide: null, what: 'the lit sign on top — this is also the menu item' },
  'side-left': { aspect: FLANK.aspect, guide: 'flank-left', what: "the left flank — the machine's outline, front at the right" },
  'side-right': { aspect: FLANK.aspect, guide: 'flank-right', what: 'the right flank — the same outline mirrored, front at the left' },
  panel: { aspect: DECK, guide: null, what: 'the control deck, seen from straight above' },
  bezel: { aspect: BEZEL.aspect, guide: 'screen', what: 'the surround; the screen sits in the marked hole' },
  attract: { aspect: SCREEN, guide: null, what: 'a still for the screen, where no loop has been filmed' },
}

/** Guides drawn inside a slot, in pixels. */
function guide(kind, x, y, w, h) {
  if (kind === 'screen') {
    const b = BEZEL.hole
    return [
      '-fill', GUIDE_DARK, '-stroke', 'none',
      '-draw', `rectangle ${x + b.x0 * w},${y + b.y0 * h} ${x + b.x1 * w},${y + b.y1 * h}`,
      '-fill', LABEL, '-pointsize', String(Math.max(12, Math.round(h * 0.05))),
      '-annotate', `+${Math.round(x + b.x0 * w + w * 0.02)}+${Math.round(y + b.y0 * h + h * 0.1)}`, 'SCREEN',
    ]
  }
  if (kind === 'flank-left' || kind === 'flank-right') {
    const pts = FLANK.outline
      .map(([u, v]) => [kind === 'flank-left' ? 1 - u : u, v])
      .map(([u, v]) => `${Math.round(x + u * w)},${Math.round(y + v * h)}`)
    return ['-fill', GUIDE, '-stroke', 'none', '-draw', `polygon ${pts.join(' ')}`]
  }
  return []
}

/**
 * The sheet: every panel laid out on one canvas, each at its own shape, with a label above it in the
 * gutter. Sizes are chosen so the biggest panel is worth several megapixels of whatever the generator
 * hands back, and so no two slots are the same shape — which is what lets the cutter tell them apart
 * by position alone when the canvas comes back a different size, as it always does.
 */
const SHEET = { w: 2048, h: 1536 }
const SLOTS = {
  marquee: { x: 64, y: 120, w: 1100, label: 'MARQUEE' },
  panel: { x: 64, y: 1000, w: 1100, label: 'CONTROL PANEL' },
  'side-left': { x: 1256, y: 120, w: 300, label: 'SIDE — LEFT' },
  'side-right': { x: 1640, y: 120, w: 300, label: 'SIDE — RIGHT' },
  bezel: { x: 1256, y: 1000, w: 684, label: 'BEZEL' },
}

function drawSheet() {
  const args = ['-size', `${SHEET.w}x${SHEET.h}`, `xc:${FIELD}`]
  const slots = {}
  for (const [name, s] of Object.entries(SLOTS)) {
    const h = Math.round(s.w / PANELS[name].aspect)
    args.push('-fill', SLOT, '-stroke', 'none', '-draw', `rectangle ${s.x},${s.y} ${s.x + s.w},${s.y + h}`)
    args.push(...guide(PANELS[name].guide, s.x, s.y, s.w, h))
    args.push('-fill', LABEL, '-pointsize', '34', '-annotate', `+${s.x}+${s.y - 18}`, s.label)
    slots[name] = { x: s.x / SHEET.w, y: s.y / SHEET.h, w: s.w / SHEET.w, h: h / SHEET.h, aspect: PANELS[name].aspect }
  }
  const file = path.join(OUT, 'sheet.png')
  execFileSync('magick', [...args, file])
  writeFileSync(path.join(OUT, 'sheet.json'), `${JSON.stringify({ canvas: SHEET, slots }, null, 2)}\n`)
  console.log(`${path.relative(ROOT, file)}  ${SHEET.w}×${SHEET.h} — every panel at once, labelled; slots in sheet.json`)
}

mkdirSync(OUT, { recursive: true })
drawSheet()

/** ext/ is the scratch directory art comes and goes through, so the sheet lives there too. */
const ext = path.join(ROOT, 'ext')
if (existsSync(ext)) copyFileSync(path.join(OUT, 'sheet.png'), path.join(ext, 'sheet.png'))

for (const [name, p] of Object.entries(PANELS)) {
  // The long edge is what matters: a flank is four times taller than it is wide.
  const w = p.aspect >= 1 ? 1400 : Math.round(1400 * p.aspect)
  const h = Math.round(w / p.aspect)
  const file = path.join(OUT, `${name}.png`)
  execFileSync('magick', ['-size', `${w}x${h}`, `xc:${SLOT}`, ...guide(p.guide, 0, 0, w, h), file])
  console.log(`${path.relative(ROOT, file)}  ${w}×${h} (${p.aspect.toFixed(2)}:1) — ${p.what}`)
}

console.log(`\nsheet.png is copied into ext/ as well, which is where the art goes in and out.
Attach it to fill a whole cabinet in one go, or one of the panel templates above to
redo a single face. Either way, send a picture of the art to match with it, and use
the prompts in apps/arcade/ART.md — they are written to go with these shapes.`)
