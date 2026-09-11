#!/usr/bin/env node
// Draw the blank layout templates you hand an image generator to get fighter and stage art back.
//
//   node scripts/fighter-template.mjs      # writes apps/fighter/art-templates/*.png + sheets.json
//
// Same trick as scripts/cabinet-template.mjs and for the same reason: a chat image generator asked
// for "twenty poses in a grid" gives you seventeen poses in a puddle. Give it a drawn grid with a
// labelled box per pose and it fills the boxes in. We drew the grid, so cutting the poses back out
// is arithmetic — no detection, no chroma key, nothing to eyeball. The slots go to sheets.json as
// fractions of the canvas, so a generator handing back a different pixel size changes nothing.
//
// THE CANVAS IS 2390x1792 because that is what the generator we use actually returns, and it is
// exactly 4:3. Matching it means no resampling of our own grid lines and labels on the way in, and
// a 1:1 pixel mapping on the way out. Any other 4:3 output still works — the cutter centre-crops
// anything that is not 4:3 and says so.
//
// WHY TWENTY BOXES AND NOT MORE. Not pixels. Every pose on a sheet has to be drawn at one shared
// character scale, or the sprite pumps like a balloon when it animates — and the widest pose in the
// set, a sweep, is about 1.35x as wide as the fighter is tall. That is what sets the box aspect,
// and the box aspect is what sets how many fit. At 2390 wide:
//
//     4 x 3 = 12   547x504   fighter 413 tall   sweep 557 wide   does NOT fit
//     5 x 4 = 20   431x362   fighter 296 tall   sweep 399 wide   fits, with margin
//     6 x 4 = 24   353x362   fighter 296 tall   sweep 399 wide   does NOT fit
//
// So twenty. A 296px fighter is comfortably above what the machines this is imitating ever had, and
// the painted look upscales far better than pixel art would — which is the other half of the reason
// for choosing it. The real ceiling above twenty is not resolution, it is the generator losing track
// of its own instructions, and twenty terse lines is about where that starts.
//
// The sheets, in the order you use them:
//
//   reference.png   one character, studied — full figure, three heads, details, palette. The
//                   character bible, and the input image for everything below.
//   moves-a.png     twenty poses: a COMPLETE playable fighter. Movement, guard, every normal,
//                   the throw, and the reactions. One sheet per character is the whole roster.
//   moves-b.png     twenty more: both specials, the in-between frames that make it animate, and
//                   the flourishes. Optional, per character, whenever.
//   stage.png       one arena as three parallax layers and a floor.
//   props.png       twenty cut-out objects to scatter through a stage.
//   turnaround.png  one pose from eight cameras at two heights. For the 3D pipeline only.
//   portrait.png    the select-screen mug shot, square.
//
// The field grey is the key colour: every pose is cut out of it by flood fill, which is why the
// prompts tell the generator to keep the background flat and to keep grey out of the costume.
//
// Each pose box has a faint floor line. Grounded poses stand on it and airborne poses float above
// it, so every frame shares one ground plane. fighter-sheet.mjs records where that line ended up in
// each trimmed frame, which is the anchor the game draws from.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'apps/fighter/art-templates')

const FIELD = '#6f6f6f' // the gutters
const SLOT = '#8f8f8f' // inside a box, and the colour that gets keyed out
const FLOOR = '#828282' // the floor line: readable to a model, inside the key's tolerance
const INK = '#1a1a1a' // labels, which live in the gutters and are cut away with them

/** What the generator actually returns, and exactly 4:3. */
const CANVAS = { w: 2390, h: 1792 }

/** How far up a pose box the floor line sits, as a fraction of box height. */
const GROUND = 0.14

const MARGIN = { top: 98, side: 51, bottom: 51, gapX: 33, gapY: 65 }

/** A grid of equal boxes inside the canvas, laid out from the margins rather than hand-placed. */
function grid(cols, rows, m = MARGIN) {
  const w = Math.round((CANVAS.w - m.side * 2 - m.gapX * (cols - 1)) / cols)
  const h = Math.round((CANVAS.h - m.top - m.bottom - m.gapY * (rows - 1)) / rows)
  return (i, j) => ({ x: m.side + i * (w + m.gapX), y: m.top + j * (h + m.gapY), w, h })
}

/**
 * Sheet A is a complete fighter on its own, and that is the point: stand, walk both ways, crouch,
 * jump, guard high and low, every normal on the ground and in the air, the sweep, the throw, and
 * the three reactions. Twelve bibles and twelve of these is a playable twelve-character roster in
 * twenty-four generations.
 */
const POSES_A = [
  ['idle', 'IDLE'],
  ['walk-fwd', 'WALK FORWARD'],
  ['walk-back', 'WALK BACK'],
  ['crouch', 'CROUCH'],
  ['block-high', 'BLOCK HIGH'],
  ['block-low', 'BLOCK LOW'],
  ['jump-up', 'JUMP UP'],
  ['jump-fwd', 'JUMP FORWARD'],
  ['punch-light', 'LIGHT PUNCH'],
  ['punch-heavy', 'HEAVY PUNCH'],
  ['kick-light', 'LIGHT KICK'],
  ['kick-heavy', 'HEAVY KICK'],
  ['crouch-punch', 'CROUCH PUNCH'],
  ['sweep', 'SWEEP'],
  ['air-punch', 'AIR PUNCH'],
  ['air-kick', 'AIR KICK'],
  ['throw', 'THROW'],
  ['hit', 'HIT'],
  ['ko', 'KNOCKED OUT'],
  ['victory', 'VICTORY'],
]

/**
 * Sheet B is polish. Box 1 is IDLE again and is NOT a new pose — it is a scale anchor. Two sheets
 * generated in two separate conversations will not agree on how big the character is, and there is
 * no way to ask for agreement across images the model cannot see at once. So we ask for one pose
 * twice, measure it, and rescale the whole sheet to match. See fighter-sheet.mjs.
 */
const POSES_B = [
  ['idle', 'IDLE  (scale anchor - draw exactly as on the first sheet)'],
  ['special-1-wind', 'SPECIAL 1 WIND UP'],
  ['special-1-fire', 'SPECIAL 1 RELEASE'],
  ['special-1-recover', 'SPECIAL 1 RECOVERY'],
  ['special-2-wind', 'SPECIAL 2 WIND UP'],
  ['special-2-fire', 'SPECIAL 2 RELEASE'],
  ['launched', 'OFF THEIR FEET'],
  ['dizzy', 'DIZZY'],
  ['taunt', 'TAUNT'],
  ['intro', 'INTRO POSE'],
  ['victory-2', 'VICTORY 2'],
  ['idle-2', 'IDLE 2'],
  ['walk-fwd-2', 'WALK FORWARD 2'],
  ['walk-back-2', 'WALK BACK 2'],
  ['punch-heavy-wind', 'HEAVY PUNCH WIND UP'],
  ['kick-heavy-wind', 'HEAVY KICK WIND UP'],
  ['hit-low', 'HIT LOW'],
  ['wakeup', 'GETTING UP'],
  ['air-neutral', 'AIR NEUTRAL'],
  ['guard-push', 'GUARD PUSH'],
]

/**
 * Eight cameras round one pose: four at eye level ninety degrees apart, four raised thirty degrees
 * and offset forty-five, so the set covers the top of the head and the shoulders as well as the
 * ring. A single ring all at eye level reconstructs into a character with a hole in their skull.
 */
const VIEWS = [
  ['front', 'FRONT'],
  ['right', 'RIGHT SIDE'],
  ['back', 'BACK'],
  ['left', 'LEFT SIDE'],
  ['high-45', 'HIGH 45'],
  ['high-135', 'HIGH 135'],
  ['high-225', 'HIGH 225'],
  ['high-315', 'HIGH 315'],
]

/** Cut-out objects to dress a stage with. Same grid as the pose sheets; no floor line. */
const PROPS = [
  ['drum', 'OIL DRUM'],
  ['drum-fire', 'BURNING BARREL'],
  ['pallets', 'PALLET STACK'],
  ['tyres', 'TYRE STACK'],
  ['crate', 'CRATE'],
  ['fence', 'CHAIN-LINK SECTION'],
  ['floodlight', 'FLOODLIGHT RIG'],
  ['generator', 'GENERATOR'],
  ['ladder', 'LADDER'],
  ['pipe', 'PIPE RUN'],
  ['sign', 'HAZARD SIGN'],
  ['bench', 'BENCH'],
  ['bucket', 'MOP BUCKET'],
  ['cable', 'CABLE COIL'],
  ['crowd-a', 'CROWD FIGURE A'],
  ['crowd-b', 'CROWD FIGURE B'],
  ['crowd-c', 'CROWD FIGURE C'],
  ['banner', 'HANGING BANNER'],
  ['speaker', 'PA SPEAKER'],
  ['debris', 'RUBBLE PILE'],
]

/**
 * One arena, as the layers a side-on fighter actually needs. The camera pans and zooms, so the far
 * layer moves slowly, the mid layer faster, and the floor is a shallow band seen nearly edge-on.
 * Drawing them stacked on one canvas keeps them in one palette and one light, which is the thing
 * that goes wrong when layers are generated separately.
 */
function stageSlots() {
  const { side, top, gapY } = MARGIN
  const w = CANVAS.w - side * 2
  const far = { x: side, y: top, w, h: 700 }
  const mid = { x: side, y: far.y + far.h + gapY, w, h: 480 }
  const floor = { x: side, y: mid.y + mid.h + gapY, w, h: CANVAS.h - 51 - (mid.y + mid.h + gapY) }
  return {
    far: { ...far, label: 'FAR LAYER - sky, skyline, distance' },
    mid: { ...mid, label: 'MID LAYER - the room itself, crowd, structure' },
    floor: { ...floor, label: 'FLOOR - the ground, seen almost edge on' },
  }
}

function gridSlots(entries, cols, rows, { floor = true } = {}) {
  const at = grid(cols, rows)
  const out = {}
  entries.forEach(([id, label], n) => {
    out[id] = { ...at(n % cols, Math.floor(n / cols)), label: `${n + 1}. ${label}`, floor }
  })
  return out
}

/** The character bible: one big figure, the head three ways, the details, and the palette. */
function referenceSlots() {
  const { side, top, gapX, gapY } = MARGIN
  const figW = 724
  const rightX = side + figW + gapX
  const rightW = CANVAS.w - side - rightX
  const colW = Math.round((rightW - gapX * 2) / 3)
  const rowH = 536
  const col = (i) => rightX + i * (colW + gapX)
  const palY = top + (rowH + gapY) * 2
  return {
    figure: { x: side, y: top, w: figW, h: CANVAS.h - top - 51, label: 'FULL FIGURE - A POSE', floor: true },
    'head-front': { x: col(0), y: top, w: colW, h: rowH, label: 'HEAD - FRONT' },
    'head-three-quarter': { x: col(1), y: top, w: colW, h: rowH, label: 'HEAD - THREE QUARTER' },
    'head-profile': { x: col(2), y: top, w: colW, h: rowH, label: 'HEAD - PROFILE' },
    hands: { x: col(0), y: top + rowH + gapY, w: colW, h: rowH, label: 'HANDS' },
    feet: { x: col(1), y: top + rowH + gapY, w: colW, h: rowH, label: 'FEET' },
    gear: { x: col(2), y: top + rowH + gapY, w: colW, h: rowH, label: 'GEAR AND WEAPON' },
    palette: { x: rightX, y: palY, w: rightW, h: CANVAS.h - 51 - palY, label: 'PALETTE - FLAT SWATCHES' },
  }
}

function draw(file, slots) {
  const args = ['-size', `${CANVAS.w}x${CANVAS.h}`, `xc:${FIELD}`]
  for (const s of Object.values(slots)) {
    args.push('-fill', SLOT, '-stroke', 'none', '-draw', `rectangle ${s.x},${s.y} ${s.x + s.w},${s.y + s.h}`)
    if (s.floor) {
      const y = Math.round(s.y + s.h * (1 - GROUND))
      args.push('-fill', FLOOR, '-draw', `rectangle ${s.x},${y - 1} ${s.x + s.w},${y + 1}`)
    }
    args.push('-fill', INK, '-pointsize', '33', '-annotate', `+${s.x}+${s.y - 18}`, s.label)
  }
  execFileSync('magick', [...args, file])
  return Object.fromEntries(
    Object.entries(slots).map(([id, s]) => [
      id,
      { x: s.x / CANVAS.w, y: s.y / CANVAS.h, w: s.w / CANVAS.w, h: s.h / CANVAS.h, ground: s.floor ? GROUND : null },
    ]),
  )
}

mkdirSync(OUT, { recursive: true })

const sheets = {
  reference: referenceSlots(),
  'moves-a': gridSlots(POSES_A, 5, 4),
  'moves-b': gridSlots(POSES_B, 5, 4),
  stage: stageSlots(),
  props: gridSlots(PROPS, 5, 4, { floor: false }),
  turnaround: gridSlots(VIEWS, 4, 2),
}

const layout = { canvas: CANVAS, sheets: {} }
for (const [name, slots] of Object.entries(sheets)) {
  const file = path.join(OUT, `${name}.png`)
  layout.sheets[name] = draw(file, slots)
  const any = Object.values(slots)[0]
  console.log(`${path.relative(ROOT, file)}  ${CANVAS.w}x${CANVAS.h}  ${Object.keys(slots).length} boxes  ${any.w}x${any.h} each`)
}

// The mug shot has no grid and no floor: one square, one head and shoulders.
const portrait = path.join(OUT, 'portrait.png')
execFileSync('magick', ['-size', '1024x1024', `xc:${SLOT}`, portrait])
layout.sheets.portrait = { portrait: { x: 0, y: 0, w: 1, h: 1, ground: null } }
console.log(`${path.relative(ROOT, portrait)}  1024x1024  the select-screen mug shot`)

writeFileSync(path.join(OUT, 'sheets.json'), `${JSON.stringify(layout, null, 2)}\n`)

/** ext/ is the scratch directory art comes and goes through, so the templates live there too. */
const ext = path.join(ROOT, 'ext')
if (existsSync(ext)) {
  for (const f of [...Object.keys(sheets).map((n) => `${n}.png`), 'portrait.png']) {
    copyFileSync(path.join(OUT, f), path.join(ext, f))
  }
}

console.log(`
Copies are in ext/ too, which is where art goes in and out. Start with reference.png and a text
prompt; everything after takes the finished reference as its first input image. The prompts are in
apps/fighter/PROMPTS.md — regenerate with scripts/fighter-prompts.mjs.`)
