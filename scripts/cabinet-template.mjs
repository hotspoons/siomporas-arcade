#!/usr/bin/env node
// Draw the blank layout templates you hand an image generator alongside a reference picture.
//
//   node scripts/cabinet-template.mjs          # writes apps/arcade/art-templates/*.png
//
// These exist because asking a chat image generator for "roughly 21:9" gets you 16:9 and a shrug.
// Attach the template instead and it has something concrete to fill: the right shape, and the
// black holes exactly where the cabinet needs them — the wheel and buttons cut out of a control
// deck, the screen out of a bezel. Whatever it draws around those lands on the cabinet correctly.
//
// The field is mid grey on purpose. White reads as paper and gets a border drawn round it; black
// reads as part of the art. Grey reads as nothing, which is what it is.

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
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

mkdirSync(OUT, { recursive: true })

for (const [name, t] of Object.entries(TEMPLATES)) {
  const file = path.join(OUT, `${name}.png`)
  const args = ['-size', `${t.w}x${t.h}`, `xc:${FIELD}`, '-fill', HOLE, '-stroke', 'none']
  for (const [kind, ...pts] of t.draw) args.push('-draw', `${kind} ${pts.join(',')}`)
  args.push(file)
  execFileSync('magick', args)
  console.log(`${path.relative(ROOT, file)}  ${t.w}×${t.h} (${(t.w / t.h).toFixed(2)}:1) — ${t.what}`)
}

console.log(`\nAttach one of these to the generator along with a picture of the art you want it to
match, and ask for that panel. See apps/arcade/ART.md.`)
