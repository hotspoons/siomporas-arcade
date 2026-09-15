#!/usr/bin/env node
// Generate a character's animation frames ONE AT A TIME, key them, and hand them to the packer.
//
//   node scripts/fighter-frames.mjs kestrel ext/kestrel-reference.png
//   node scripts/fighter-frames.mjs kestrel ext/kestrel-reference.png --only idle,walk-fwd
//   node scripts/fighter-frames.mjs kestrel ext/kestrel-reference.png --redo    # ignore what exists
//
// This replaces the grid sheets for character animation. `fighter-sheet.mjs` still cuts stages,
// props and anything else laid out in boxes; it is only the fighter that moved.
//
// WHY. A sheet asks the model to manage a layout as well as draw, and every defect that reached the
// game came from the layout half: grids rewritten from twenty boxes to twelve, two figures packed
// into one box, close-ups filed as poses, feet clipped at a box edge, scale drifting cell to cell.
// A single figure on flat green has none of those failure modes. It also keys trivially — one
// subject, one background, no isolated regions the flood fill cannot reach — and it is the only
// form in which a proportion reference works at all: attach one to a sheet and the grid comes back
// rewritten, attach one to a single figure and the build transfers.
//
// The cost is about twice the wall clock. That is the whole price.
//
// WHAT IT HANDS OVER is what `pack-frames.mjs` asks for: one directory per animation, every frame
// the same size, uncropped, alpha where the background was, plus a `pack.json`. The anchor is still
// computed once, by the packer.
//
// THE ONE THING A SHEET GAVE US FOR FREE was horizontal registration: a box has a centre, so the
// fighter was always in the same place across a row. Independent generations are not, and a frame
// whose figure sits eighty pixels left of the last one makes the character slide across the screen.
// So each frame is re-centred here, on the FEET rather than on the bounding box — a punch extends
// the bounding box forwards, and centring on it would shove the fighter backwards exactly when she
// lunges. The feet stay put in the drawing, which is the same reason the anchor is at the feet.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 1024
/** How much of the figure, measured up from its lowest row, counts as "the feet". */
const FOOT_BAND = 0.08

const magick = (args) => execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim()

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const flag = (f, d = null) => {
  const i = argv.indexOf(`--${f}`)
  return i === -1 ? d : argv[i + 1]
}
const taken = new Set([flag('only'), flag('steps'), flag('fuzz'), flag('seed')].filter(Boolean))
const [character, reference] = argv.filter((a) => !a.startsWith('--') && !taken.has(a))

if (!character || !reference) {
  console.error(`usage: node scripts/fighter-frames.mjs <character-id> <reference.png> [options]

  --only a,b     just these animations
  --redo         regenerate frames that already exist
  --steps N      default 40
  --fuzz N       key tolerance, percent (default 16)
  --seed N       base seed (default 100); each frame gets seed + its position

The reference is a finished single figure of the character at the build you want — everything is
drawn to match it. See ART.md.`)
  process.exit(1)
}
if (!existsSync(reference)) {
  console.error(`fighter-frames: no such reference: ${reference}`)
  process.exit(1)
}

const steps = Number(flag('steps', '40'))
const fuzz = Number(flag('fuzz', '16'))
const baseSeed = Number(flag('seed', '100'))
const only = flag('only') ? new Set(flag('only').split(',').map((x) => x.trim())) : null

const { flux } = await import('./flux-art.mjs')

const jobs = JSON.parse(
  execFileSync('node', [path.join(ROOT, 'scripts/fighter-prompts.mjs'), '--frames', character], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  }),
).filter((j) => !only || only.has(j.anim))

if (!jobs.length) {
  console.error(`nothing to do — no animations matched${only ? ` --only ${[...only].join(',')}` : ''}`)
  process.exit(1)
}

const artDir = path.join(ROOT, 'ext/art', character)
console.log(`${character}: ${jobs.length} frames from ${path.relative(ROOT, reference)}`)

/**
 * Key the green, then slide the figure sideways so the middle of its feet sits on the canvas
 * centre. Returns the ink coverage, which is the cheap tell that a key went wrong.
 */
function keyAndCentre(raw, out) {
  const tmp = `${out}.tmp.png`
  // The colour is sampled rather than named: the generator returns its own version of the green
  // and a constant would turn that drift into a failure.
  const key = magick([raw, '-format', '%[pixel:p{12,12}]', 'info:'])
  magick([raw, '-alpha', 'set', '-fuzz', `${fuzz}%`, '-transparent', key,
    '-channel', 'A', '-blur', '0x0.5', '-level', '40%,60%', '+channel', tmp])

  const bbox = magick([tmp, '-format', '%@', 'info:'])
  const m = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(bbox)
  if (!m) {
    rmSync(tmp, { force: true })
    return null
  }
  const [, w, h, x, y] = m.map(Number)

  // The feet: the bottom slice of the figure, and the middle of what is opaque in it.
  const band = Math.max(4, Math.round(h * FOOT_BAND))
  const footBox = magick([tmp, '-crop', `${w}x${band}+${x}+${y + h - band}`, '+repage', '-format', '%@', 'info:'])
  const fm = /^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/.exec(footBox)
  const footCentre = fm ? x + Number(fm[3]) + Number(fm[1]) / 2 : x + w / 2

  const dx = Math.round(SIZE / 2 - footCentre)
  magick([tmp, '-background', 'none', '-page', `+${dx}+0`, '-flatten',
    '-background', 'none', '-gravity', 'northwest', '-extent', `${SIZE}x${SIZE}`, out])
  const ink = Number(magick([out, '-format', '%[fx:mean.a*100]', 'info:'])) || 0
  rmSync(tmp, { force: true })
  return { ink, dx }
}

let made = 0
let skipped = 0
let failed = 0
let lastAnim = null

for (const [n, job] of jobs.entries()) {
  const dir = path.join(artDir, job.anim)
  mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `${String(job.index).padStart(2, '0')}.png`)

  if (job.anim !== lastAnim) {
    console.log(`\n  ${job.anim}`)
    lastAnim = job.anim
  }
  if (existsSync(out) && !has('redo')) {
    skipped++
    continue
  }

  const raw = path.join(ROOT, 'shots', `.frame-${character}-${job.anim}-${job.index}.png`)
  mkdirSync(path.dirname(raw), { recursive: true })
  try {
    // One seed per frame rather than one per animation: identical seeds across frames pull the
    // poses toward each other, which is the opposite of what an animation needs.
    const r = await flux({
      prompt: job.prompt,
      attach: [reference],
      size: `${SIZE}x${SIZE}`,
      steps,
      seed: baseSeed + n,
      trueCfg: 4,
      negative:
        'close-up, cropped, zoomed in, two figures, realistic proportions, small head, ' +
        'man, beard, hair, ponytail, boots, shoes, gloves, weapon, cast shadow, ground shadow, text',
    })
    writeFileSync(raw, r.png)
    const k = keyAndCentre(raw, out)
    rmSync(raw, { force: true })
    if (!k) {
      console.log(`    ${job.index} nothing survived the key`)
      failed++
      continue
    }
    const warn = k.ink > 60 ? '  <- key may have failed' : k.ink < 4 ? '  <- almost nothing left' : ''
    console.log(`    ${job.index}  ${k.ink.toFixed(0)}% ink  recentred ${k.dx >= 0 ? '+' : ''}${k.dx}px  ${r.seconds.toFixed(0)}s${warn}`)
    made++
  } catch (e) {
    console.log(`    ${job.index} FAILED: ${String(e.message).slice(0, 120)}`)
    failed++
  }
}

// The floor is the drawing's, not a line we drew: nothing here has a template floor to stand on, so
// every frame is anchored on its own lowest row. anchorX is the canvas centre because that is where
// the feet were moved to.
const packFile = path.join(artDir, 'pack.json')
const pack = existsSync(packFile) ? JSON.parse(readFileSync(packFile, 'utf8')) : {}
const asMap = (v) => (v && typeof v === 'object' ? { ...v } : {})
pack.floorY = asMap(pack.floorY)
pack.anchorX = asMap(pack.anchorX)
for (const a of new Set(jobs.map((j) => j.anim))) {
  if (pack.floorY[a] == null) pack.floorY[a] = a === 'knockdown' ? 'content' : 'frame'
  pack.anchorX[a] = SIZE / 2
}
writeFileSync(packFile, `${JSON.stringify(pack, null, 2)}\n`)

console.log(`\n${made} generated, ${skipped} already there, ${failed} failed`)
console.log(`${path.relative(ROOT, packFile)} written`)
console.log(`pack them with: node scripts/pack-frames.mjs ext/art/${character} ${character} --height 90 --contact`)
