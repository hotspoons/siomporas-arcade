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

const taken = new Set([flag('fuzz'), flag('only')].filter(Boolean))
const positional = argv.filter((a) => !a.startsWith('--') && !taken.has(a))
const [src, character, sheetName] = positional

if (!src || !character || !SHEETS.includes(sheetName)) {
  console.error(`usage: node scripts/fighter-sheet.mjs <filled-template> <character-id> <${SHEETS.join('|')}> [options]

  --dry-run          cut to shots/ and build a contact sheet; install nothing
  --fuzz N           key tolerance, percent (default 14). Raise if grey survives, lower if the
                     costume is being eaten.
  --keep-bg          do not key at all — cut the boxes and leave the grey in
  --only a,b,c       just these frames

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
const outDir = dry ? path.join(ROOT, 'shots', `fighter-${character}-${sheetName}`) : path.join(ROOT, 'apps/fighter/public/chars', character)
mkdirSync(outDir, { recursive: true })

const manifest = path.join(ROOT, 'apps/fighter/public/chars', character, 'frames.json')
const installed = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : { character, frames: {} }

console.log(`${path.relative(ROOT, src)} -> ${character}/${sheetName}${dry ? '  (dry run)' : ''}`)

const frames = {}
const cut = []
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
    // Inward from each corner, a few pixels in so a soft edge on the box border does not stop it.
    const inset = 3
    args.push('-alpha', 'set', '-fill', 'none', '-fuzz', `${fuzz}%`)
    for (const [cx, cy] of [
      [inset, inset],
      [box.w - 1 - inset, inset],
      [inset, box.h - 1 - inset],
      [box.w - 1 - inset, box.h - 1 - inset],
    ])
      args.push('-draw', `alpha ${cx},${cy} floodfill`)
    // The fill leaves a grey halo on the antialiased edge; two passes of despeckle-free cleanup is
    // overkill, but pulling the matte in by half a pixel kills the fringe cheaply.
    args.push('-channel', 'A', '-blur', '0x0.5', '-level', '40%,60%', '+channel')
  }

  const cell = path.join(ROOT, 'shots', `.fighter-cell-${name}.png`)
  mkdirSync(path.dirname(cell), { recursive: true })
  magick([...args, cell])

  // Bounding box of what survived, so the anchor can be rebased into the trimmed frame.
  const bboxRaw = magick([cell, '-format', '%@', 'info:']).trim()
  const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(bboxRaw)
  if (!m) {
    console.log(`  ${name.padEnd(18)} nothing left after keying — try --fuzz ${Math.max(2, fuzz - 6)} or --keep-bg`)
    rmSync(cell, { force: true })
    continue
  }
  const bbox = { w: +m[1], h: +m[2], x: +m[3], y: +m[4] }

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

  const fill = ((bbox.w * bbox.h) / (box.w * box.h)) * 100
  const warn = fill > 92 ? '  <- filled the box; the key may have failed' : fill < 12 ? '  <- almost nothing survived' : ''
  console.log(`  ${name.padEnd(18)} ${final.w}x${final.h}  anchor ${frames[name].anchor.join(',')}  ${fill.toFixed(0)}% of box${warn}`)
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
