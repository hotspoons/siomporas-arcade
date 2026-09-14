#!/usr/bin/env node
// Cut a filled-in fighter template into frames, with the background keyed out and the feet found.
//
//   node scripts/fighter-sheet.mjs ext/kestrel-a.png kestrel moves-a --dry-run
//   node scripts/fighter-sheet.mjs ext/kestrel-a.png kestrel moves-a
//   node scripts/fighter-sheet.mjs ext/kestrel-turn.png kestrel turnaround
//   node scripts/fighter-sheet.mjs ext/kestrel-a.png kestrel moves-a --fuzz 18 --only idle,sweep
//
// The companion to fighter-template.mjs. Three jobs, in order:
//
// CUT. We drew the grid, so every box is at a known fraction of the canvas (art-templates/
// sheets.json) and cutting is arithmetic. A generator handing back a different pixel size does not
// move a box proportionally; a generator handing back a different *aspect* does, so anything that
// is not the template's 4:3 gets centre-cropped to it first and says so.
//
// KEY. A sprite needs alpha. Flood fill inward from all four corners of each box, which works
// because the template's background is one flat grey and the prompt asks for it to stay that way.
// This is the step that goes wrong: a costume close to the key grey gets eaten, and a fighter whose
// limb touches the edge of the box lets the fill leak inside them. --fuzz tunes the tolerance and
// --keep-bg skips keying entirely so you can matte a difficult frame by hand.
//
// SCALE. Two sheets generated in two conversations will not agree on how big the character is, and
// there is no way to prompt around it — the model cannot see the other sheet. So every sheet after
// the first repeats one pose (IDLE) purely as a scale anchor: we measure it, compare it against the
// IDLE already installed, rescale everything from this sheet to match, and throw the repeat away.
// This is the single thing standing between a character who animates and a character who breathes.
//
// ANCHOR. This is the part that makes cut sprites usable and is easy not to think of. Every frame
// trims to a different bounding box — a sweep is wide and short, an uppercut is tall and narrow —
// so drawing them all at the same screen position makes the character jitter. The template puts a
// floor line at a known height in every box, so for each frame we record where that floor line and
// the box's centre line ended up relative to the trimmed image. The game draws every frame from
// that anchor and the character stands still. It goes to frames.json next to the sprites.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = path.join(ROOT, 'apps/fighter/art-templates')

// The key colour is never named here on purpose: the fill samples whatever is actually in the
// corners of the box, so a generator that shifts the background a few percent off the template's
// grey still keys cleanly. Naming the colour would make that a failure instead.

function magick(args) {
  return execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
}

function size(file) {
  const [w, h] = magick([file, '-format', '%w %h', 'info:']).trim().split(/\s+/).map(Number)
  return { w, h }
}

const argv = process.argv.slice(2)
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
}
const has = (name) => argv.includes(`--${name}`)

const layout = JSON.parse(readFileSync(path.join(TEMPLATES, 'sheets.json'), 'utf8'))
const SHEETS = Object.keys(layout.sheets)

const taken = new Set([flag('fuzz'), flag('only'), flag('untrimmed')].filter(Boolean))
const positional = argv.filter((a) => !a.startsWith('--') && !taken.has(a))
const [src, character, sheetName] = positional

if (!src || !character || !SHEETS.includes(sheetName)) {
  console.error(`usage: node scripts/fighter-sheet.mjs <filled-template> <character-id> <${SHEETS.join('|')}> [options]

  --dry-run          cut to shots/ and build a contact sheet; install nothing
  --fuzz N           key tolerance, percent (default 14). Raise if grey survives, lower if the
                     costume is being eaten.
  --keep-bg          do not key at all — cut the boxes and leave the grey in
  --only a,b,c       just these frames
  --untrimmed NAME   hand the frames to scripts/pack-frames.mjs instead of installing them:
                     writes ext/art/<character>/NAME/00.png.. keyed, UNCROPPED and all one size,
                     plus ext/art/<character>/pack.json. For the cycle sheets.

Hand a generator apps/fighter/art-templates/<sheet>.png with the character's reference art, ask it
to fill in every box, and run this on what comes back. See apps/fighter/ART.md.`)
  process.exit(1)
}
if (!existsSync(src)) {
  console.error(`fighter-sheet: no such file: ${src}`)
  process.exit(1)
}

const slots = layout.sheets[sheetName]
const only = flag('only') ? new Set(flag('only').split(',').map((s) => s.trim())) : null
const fuzz = Number(flag('fuzz', '14'))
const dry = has('dry-run')
/** A stage layer is a background. Keying its background out would leave nothing. */
const keepBg = has('keep-bg') || sheetName === 'stage'
/** The pose every sheet after the first repeats, so scale can be reconciled. */
const ANCHOR = 'idle'

const got = size(src)
const want = layout.canvas.w / layout.canvas.h
const have = got.w / got.h
let work = src

// The boxes are fractions, so the shape has to match before any of them mean anything.
if (Math.abs(have - want) > 0.02) {
  work = path.join(ROOT, 'shots', `.fighter-${character}-${sheetName}.png`)
  mkdirSync(path.dirname(work), { recursive: true })
  const box = have > want ? { w: Math.round(got.h * want), h: got.h } : { w: got.w, h: Math.round(got.w / want) }
  magick([src, '-crop', `${box.w}x${box.h}+${Math.round((got.w - box.w) / 2)}+${Math.round((got.h - box.h) / 2)}`, '+repage', work])
  console.log(`came back ${got.w}x${got.h} (${have.toFixed(2)}:1) — centre-cropped to the template's ${want.toFixed(2)}:1`)
}

const sheet = size(work)

/**
 * UNTRIMMED. The frames go to the packer rather than into the game, and the packer computes the
 * anchor.
 *
 * Both ends of this pipeline had grown their own anchor arithmetic — this cutter deriving it from
 * the template's drawn floor line, `pack-frames.mjs` deriving it from a `floorY` it is told. Two
 * sources of truth for the one number that keeps a character from jittering is a bug waiting for a
 * quiet afternoon, so the cutter now stops short: it keys each box and hands over the whole box,
 * uncropped, every frame identically sized. The shared baseline is then structural rather than
 * something this script promises, and the anchor is worked out once, next to the renderer that
 * consumes it.
 */
const untrimmed = flag('untrimmed')

const artDir = path.join(ROOT, 'ext/art', character)
const outDir = untrimmed
  ? path.join(artDir, untrimmed)
  : dry
    ? path.join(ROOT, 'shots', `fighter-${character}-${sheetName}`)
    : path.join(ROOT, 'apps/fighter/public/chars', character)
mkdirSync(outDir, { recursive: true })

const manifest = path.join(ROOT, 'apps/fighter/public/chars', character, 'frames.json')
const installed = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : { character, frames: {} }

console.log(`${path.relative(ROOT, src)} -> ${character}/${sheetName}${dry ? '  (dry run)' : ''}`)

/**
 * The key colour, sampled from inside the box rather than named. The generator returns its own
 * version of the template's green — a few percent off, sometimes lighter — and hardcoding the
 * template's value would turn that drift into a keying failure. A point 12px in from the top-left
 * corner is background on every sheet the pipeline produces.
 */
function keyColour(box) {
  const x = box.x + 12
  const y = box.y + 12
  return magick([work, '-format', `%[pixel:p{${x},${y}}]`, 'info:']).trim()
}

const frames = {}
const cut = []
let order = 0
for (const [name, slot] of Object.entries(slots)) {
  if (only && !only.has(name)) continue

  const box = {
    x: Math.round(slot.x * sheet.w),
    y: Math.round(slot.y * sheet.h),
    w: Math.round(slot.w * sheet.w),
    h: Math.round(slot.h * sheet.h),
  }

  // Where the anchor sits inside the box, before anything is trimmed off: the floor line, and the
  // box's vertical centre line. `ground` is null on boxes the template drew no floor in.
  const anchorInBox = { x: box.w / 2, y: slot.ground == null ? box.h : box.h * (1 - slot.ground) }

  const args = [work, '-crop', `${box.w}x${box.h}+${box.x}+${box.y}`, '+repage']
  if (!keepBg) {
    // Inward from each corner, at several depths. One inset is not enough: the generator often
    // paints its own thin border just inside the box edge, and a seed that lands on that border
    // floods the border and stops, leaving the whole background behind — which looks in the log
    // exactly like a costume that filled the box. Seeding at 3, 12, 24 and 40 px gets past any
    // border narrower than the gap between depths.
    //
    // Corners only, and never edge midpoints: a corner is the one part of a pose box the character
    // is almost never in, and a seed that lands on the character eats the character.
    args.push('-alpha', 'set', '-fill', 'none', '-fuzz', `${fuzz}%`)
    for (const inset of [3, 12, 24, 40]) {
      if (inset * 2 >= Math.min(box.w, box.h)) break
      for (const [cx, cy] of [
        [inset, inset],
        [box.w - 1 - inset, inset],
        [inset, box.h - 1 - inset],
        [box.w - 1 - inset, box.h - 1 - inset],
      ])
        args.push('-draw', `alpha ${cx},${cy} floodfill`)
    }
    // THEN A GLOBAL PASS, because a flood fill cannot reach everywhere. The fill starts in the
    // corners and spreads through connected background; a figure that touches the edge of its box
    // cuts the background into pieces, and any piece with no corner in it survives — between the
    // legs, under an arm, inside the crook of a knee. It survives as a solid lump of key colour in
    // the middle of the sprite, which is worse than a halo and does not look like a keying failure
    // in the numbers.
    //
    // This is safe here in a way it was not when the templates were grey. Grey sat in the middle of
    // every costume's value range, so keying it globally ate shadows and cloth. Chroma green is
    // nowhere near skin, teal, rust, tartan or bone — the prompts forbid it in the costume for
    // exactly this reason — so anything still that colour after the fill is background by
    // definition. `--fuzz` still governs how close is close enough.
    args.push('-fuzz', `${fuzz}%`, '-transparent', keyColour(box))

    // The fill leaves a halo on the antialiased edge; two passes of despeckle-free cleanup is
    // overkill, but pulling the matte in by half a pixel kills the fringe cheaply.
    args.push('-channel', 'A', '-blur', '0x0.5', '-level', '40%,60%', '+channel')
  }

  const cell = path.join(ROOT, 'shots', `.fighter-cell-${name}.png`)
  mkdirSync(path.dirname(cell), { recursive: true })
  magick([...args, cell])

  if (untrimmed) {
    // Named by position, not by slot id: the packer orders an animation's frames by filename and
    // `f0..f5` would sort correctly only until a sheet had ten boxes.
    const n = String(order++).padStart(2, '0')
    const out = path.join(outDir, `${n}.png`)
    magick([cell, out])
    const ink = Number(magick([cell, '-format', '%[fx:mean.a*100]', 'info:'])) || 0
    rmSync(cell, { force: true })
    console.log(`  ${n}.png  ${box.w}x${box.h}  ${ink.toFixed(0)}% ink${ink < 6 ? '  <- almost nothing survived' : ''}`)
    cut.push(out)
    continue
  }

  // Bounding box of what survived, so the anchor can be rebased into the trimmed frame.
  const bboxRaw = magick([cell, '-format', '%@', 'info:']).trim()
  const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(bboxRaw)
  if (!m) {
    console.log(`  ${name.padEnd(18)} nothing left after keying — try --fuzz ${Math.max(2, fuzz - 6)} or --keep-bg`)
    rmSync(cell, { force: true })
    continue
  }
  const bbox = { w: +m[1], h: +m[2], x: +m[3], y: +m[4] }

  // How much of the box is actually still OPAQUE, not how big the surviving bounding box is. A
  // figure drawn nearly box-height has a bounding box covering 90% of the box while being mostly
  // transparent between its own limbs, and judging by bounding box called that a failed key on
  // every frame of a six-box sheet. Mean alpha is the thing the warning was always trying to ask.
  const fill = Number(magick([cell, '-format', '%[fx:mean.a*100]', 'info:'])) || 0

  const out = path.join(outDir, `${name}.webp`)
  magick([cell, '-trim', '+repage', '-define', 'webp:lossless=false', '-quality', '92', out])
  rmSync(cell, { force: true })

  const final = size(out)
  frames[name] = {
    file: `${name}.webp`,
    w: final.w,
    h: final.h,
    // Where to put the sprite: subtract this from the character's screen position.
    anchor: [Math.round(anchorInBox.x - bbox.x), Math.round(anchorInBox.y - bbox.y)],
  }
  cut.push(out)

  const warn = fill > 92 ? '  <- filled the box; the key may have failed' : fill < 6 ? '  <- almost nothing survived' : ''
  console.log(`  ${name.padEnd(18)} ${final.w}x${final.h}  anchor ${frames[name].anchor.join(',')}  ${fill.toFixed(0)}% of box${warn}`)
}

// The packer needs the floor row and the stance centre in the box it is handed, and they come from
// the same template geometry the boxes did — `boxHeight * (1 - GROUND)` and `boxWidth / 2` — rather
// than being measured off the art or agreed by hand. Written per character, merged across runs, so
// each animation can override the floor if a sheet ever needs it.
if (untrimmed) {
  const s0 = Object.values(slots)[0]
  const boxW = Math.round(s0.w * sheet.w)
  const boxH = Math.round(s0.h * sheet.h)
  const packFile = path.join(artDir, 'pack.json')
  const pack = existsSync(packFile) ? JSON.parse(readFileSync(packFile, 'utf8')) : {}
  const templateFloor = s0.ground == null ? boxH : Math.round(boxH * (1 - s0.ground))

  // BOTH NUMBERS ARE PER ANIMATION, because the sheets are not all one shape. `cycle-4` has two
  // columns where `cycle` has three, so its boxes are 967 wide against 635 and its centre line is
  // 484 against 318. Written flat, whichever animation was cut last silently imposed its geometry
  // on all the others — and an anchorX that is 166px wrong moves the character sideways the moment
  // that animation plays.
  const asMap = (v, fallback) => (v == null ? {} : typeof v === 'object' ? { ...v } : { [fallback]: v })
  pack.floorY = asMap(pack.floorY, untrimmed)
  pack.anchorX = asMap(pack.anchorX, untrimmed)

  // anchorX is pure geometry off the template, so it is always ours to write. floorY is not: the
  // packer overrides it ("frame", "content", a number) exactly when the drawing did not stand where
  // the template's line is, and rewriting that would put the character back in the air.
  pack.anchorX[untrimmed] = Math.round(boxW / 2)
  if (pack.floorY[untrimmed] == null) pack.floorY[untrimmed] = templateFloor
  else console.log(`  keeping floorY ${JSON.stringify(pack.floorY[untrimmed])} for ${untrimmed} (template line is ${templateFloor})`)
  writeFileSync(packFile, `${JSON.stringify(pack, null, 2)}\n`)
  console.log(`  ${cut.length} frames in ${path.relative(ROOT, outDir)}  (${boxW}x${boxH} each)`)
  console.log(`  ${path.relative(ROOT, packFile)}  ${untrimmed}: floorY ${JSON.stringify(pack.floorY[untrimmed])}  anchorX ${pack.anchorX[untrimmed]}`)
  console.log(`  pack them with: node scripts/pack-frames.mjs ext/art/${character} ${character} --height 90 --contact`)
  process.exit(0)
}

// Reconcile scale against the IDLE already installed, then drop this sheet's copy of it.
const priorIdle = installed.frames[ANCHOR]
if (priorIdle && frames[ANCHOR] && !only) {
  const ratio = priorIdle.h / frames[ANCHOR].h
  if (Math.abs(ratio - 1) > 0.02) {
    console.log(`  scale: this sheet's ${ANCHOR} is ${frames[ANCHOR].h}px against ${priorIdle.h}px installed`)
    console.log(`  rescaling every frame from this sheet by ${(ratio * 100).toFixed(1)}%`)
    for (const [name, f] of Object.entries(frames)) {
      if (name === ANCHOR) continue
      const file = path.join(outDir, f.file)
      magick([file, '-resize', `${(ratio * 100).toFixed(3)}%`, file])
      const now = size(file)
      f.w = now.w
      f.h = now.h
      f.anchor = [Math.round(f.anchor[0] * ratio), Math.round(f.anchor[1] * ratio)]
    }
  } else {
    console.log(`  scale: matches the installed ${ANCHOR} within 2% — nothing to reconcile`)
  }
  // The repeat was only ever a ruler.
  rmSync(path.join(outDir, frames[ANCHOR].file), { force: true })
  delete frames[ANCHOR]
} else if (frames[ANCHOR] && !priorIdle && sheetName !== 'moves-a') {
  console.log(`  note: no ${ANCHOR} installed yet, so this sheet's scale becomes the reference`)
}

// frames.json accumulates: sheet B is cut in a separate run and must not wipe sheet A.
if (!dry && Object.keys(frames).length) {
  installed.character = character
  Object.assign(installed.frames, frames)
  writeFileSync(manifest, `${JSON.stringify(installed, null, 2)}\n`)
  console.log(`  ${Object.keys(frames).length} frames installed; frames.json now has ${Object.keys(installed.frames).length}`)
}

if (dry && cut.length) {
  // Every frame padded into an identical cell and laid out in the template's own grid, so the
  // contact sheet reads as the sheet you sent. Over a checkerboard, because the question a dry run
  // answers is whether the alpha is right, and alpha over white looks exactly like white.
  const contact = path.join(ROOT, 'shots', `fighter-${character}-${sheetName}.png`)
  const cols = Math.min(4, cut.length)
  const rows = Math.ceil(cut.length / cols)
  const cell = 320
  const grid = path.join(ROOT, 'shots', `.fighter-contact-${character}.png`)
  magick(['montage', ...cut, '-background', 'none', '-tile', `${cols}x${rows}`, '-geometry', `${cell - 20}x${cell - 20}+10+10`, grid])
  const g = size(grid)
  magick(['-size', `${g.w}x${g.h}`, 'pattern:checkerboard', grid, '-composite', contact])
  rmSync(grid, { force: true })
  console.log(`  frames in ${path.relative(ROOT, outDir)}, contact sheet ${path.relative(ROOT, contact)}`)
  console.log(`  install them with the same command without --dry-run`)
}

if (work !== src) rmSync(work, { force: true })
