#!/usr/bin/env node
// Put one generated image onto one cabinet panel.
//
//   node scripts/cabinet-art.mjs ext/side-radrun.jpeg radrun side
//   node scripts/cabinet-art.mjs ~/Downloads/whatever.png apex marquee --dry-run
//
// The workflow this serves is: paste one prompt from apps/arcade/ART.md into an image generator,
// save whatever JPEG it hands back, run this. One image, one panel, no layout for the generator to
// get wrong — it only ever has to draw a single rectangle of artwork.
//
// What it does to the image:
//
//   trim    generators like to sit the art inside a flat border or a strip of letterboxing. A
//           uniform edge is cut off. Artwork that already reaches the edge is untouched.
//   crop    each panel has a shape the cabinet expects — a marquee is a wide sign, side art is a
//           tall banner. Generators offer a handful of aspect ratios and none of them will be
//           exact, so the image is centre-cropped to the panel's shape. The geometry would happily
//           take any aspect (it measures the texture and sizes the face to match), but a square
//           side panel makes a square-sided cabinet, which is not what anyone wants. --no-crop
//           keeps the whole image and lets the cabinet take whatever shape it implies.
//   encode  webp, quality 88, longest edge 1024. A marquee is 30 cm of screen at most.
//
// Everything runs through ImageMagick's CLI. There is no image library in this repo, and one panel
// every few days does not justify adding one.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { knobs, reflowBezel } from './lib/bezel.mjs'
import { conformFlank } from './lib/flank.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The panels a cabinet can wear, and the shape each one wants to be. */
const PANELS = {
  marquee: { aspect: 16 / 9, what: 'the lit sign on top' },
  // Not 9:16: a flank is the cabinet's side board, and its bounding box is depth over full height.
  'side-left': { aspect: 0.40128809, what: 'the left flank' },
  'side-right': { aspect: 0.40128809, what: 'the right flank' },
  panel: { aspect: 21 / 9, what: 'the control deck, seen from above' },
  bezel: { aspect: 4 / 3, what: 'the surround framing the screen' },
  attract: { aspect: 4 / 3, what: 'the attract screen' },
}

const GAMES = ['radrun', 'stuntin', 'apex']

function magick(args) {
  return execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
}

function size(file) {
  const [w, h] = magick([file, '-format', '%w %h', 'info:']).trim().split(/\s+/).map(Number)
  return { w, h }
}

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const [src, game, panel] = args.filter((a) => !a.startsWith('--'))

if (!src || !game || !panel) {
  console.error(`usage: node scripts/cabinet-art.mjs <image> <game> <panel> [--dry-run] [--no-crop] [--no-trim]

  game    ${GAMES.join(' | ')}
  panel   ${Object.entries(PANELS).map(([n, p]) => `${n} (${p.what})`).join('\n          ')}

The prompts that produce these are in apps/arcade/ART.md, one per panel.`)
  process.exit(1)
}
if (!existsSync(src)) {
  console.error(`cabinet-art: no such file: ${src}`)
  process.exit(1)
}
if (!GAMES.includes(game)) {
  console.error(`cabinet-art: unknown game "${game}" — one of ${GAMES.join(', ')}`)
  process.exit(1)
}
if (!(panel in PANELS)) {
  console.error(`cabinet-art: unknown panel "${panel}" — one of ${Object.keys(PANELS).join(', ')}`)
  process.exit(1)
}

// A bezel is not centre-cropped like the others: it is a frame, and where its hole is matters more
// than what shape it arrived in. scripts/lib/bezel.mjs re-lays it around the opening the cabinet
// actually has; corrections that need to survive a regenerated sheet go in art-templates/bezel.json.
if (panel === 'bezel') {
  const dest = flags.has('--dry-run')
    ? path.join(ROOT, 'shots', 'cabinet-' + game + '-bezel.webp')
    : path.join(ROOT, 'apps/arcade/public/cabinets', game, 'bezel.webp')
  mkdirSync(path.dirname(dest), { recursive: true })
  const fit = reflowBezel(src, dest, knobs(path.join(ROOT, 'apps/arcade/art-templates/bezel.json'), game))
  const pc = (v) => `${Math.round(v * 100)}%`
  console.log(`${path.relative(ROOT, src)} → ${game}/bezel.webp`)
  console.log(`  opening ${fit.detected}: ${pc(fit.opening.x0)},${pc(fit.opening.y0)} → ${pc(fit.opening.x1)},${pc(fit.opening.y1)}`)
  if (fit.mirrored.length) console.log(`  nothing drawn on the ${fit.mirrored.join(' or ')} — mirrored from the opposite side`)
  console.log(`  ${fit.size.w}×${fit.size.h}, fitted to the cabinet's opening`)
  console.log(flags.has('--dry-run') ? `  dry run — written to ${path.relative(ROOT, dest)} for a look, nothing installed` : `  installed`)
  process.exit(0)
}

// A flank is the machine's outline, and a generator only ever draws it nearly right — so it is
// conformed to the real one rather than cropped to a rectangle. See scripts/lib/flank.mjs.
if (panel === 'side-left' || panel === 'side-right') {
  const dest = flags.has('--dry-run')
    ? path.join(ROOT, 'shots', `cabinet-${game}-${panel}.webp`)
    : path.join(ROOT, 'apps/arcade/public/cabinets', game, `${panel}.webp`)
  mkdirSync(path.dirname(dest), { recursive: true })
  const fit = conformFlank(src, dest, { mirror: panel === 'side-left' })
  console.log(`${path.relative(ROOT, src)} → ${game}/${panel}.webp`)
  console.log(`  ${fit.size.w}×${fit.size.h}, conformed to the machine's outline`)
  console.log(`  ${((fit.stretch - 1) * 100).toFixed(0)}% mean stretch, ${fit.worst.toFixed(1)}× at its worst row`)
  console.log(flags.has('--dry-run') ? `  dry run — written to ${path.relative(ROOT, dest)} for a look, nothing installed` : `  installed`)
  process.exit(0)
}

const want = PANELS[panel].aspect
const before = size(src)
const steps = []

// Trim, then measure again: the crop has to be worked out on what is left after the border goes.
const work = path.join(ROOT, 'shots', `.cabinet-art-${game}-${panel}.png`)
mkdirSync(path.dirname(work), { recursive: true })
if (flags.has('--no-trim')) {
  magick([src, work])
} else {
  // 4% fuzz: enough to see a flat border as flat despite JPEG noise, not enough to eat into art.
  magick([src, '-fuzz', '4%', '-trim', '+repage', work])
  const trimmed = size(work)
  if (trimmed.w !== before.w || trimmed.h !== before.h) steps.push(`trimmed ${before.w}×${before.h} → ${trimmed.w}×${trimmed.h}`)
}

const now = size(work)
const have = now.w / now.h
let box = { w: now.w, h: now.h, x: 0, y: 0 }
if (!flags.has('--no-crop') && Math.abs(have - want) > 0.02) {
  if (have > want) {
    box.w = Math.round(now.h * want)
    box.x = Math.round((now.w - box.w) / 2)
  } else {
    box.h = Math.round(now.w / want)
    box.y = Math.round((now.h - box.h) / 2)
  }
  const cut = 100 - Math.round((100 * (box.w * box.h)) / (now.w * now.h))
  steps.push(`cropped to ${want.toFixed(2)}:1 from ${have.toFixed(2)}:1, losing ${cut}%`)
  if (cut > 35) steps.push(`⚠ that is a lot to throw away — ask the generator for a ${want > 1 ? 'wider' : 'taller'} image, or pass --no-crop`)
}

const outDir = path.join(ROOT, 'apps/arcade/public/cabinets', game)
const out = path.join(outDir, `${panel}.webp`)
const dest = flags.has('--dry-run') ? path.join(ROOT, 'shots', `cabinet-${game}-${panel}.webp`) : out

mkdirSync(path.dirname(dest), { recursive: true })
magick([work, '-crop', `${box.w}x${box.h}+${box.x}+${box.y}`, '+repage', '-resize', '1024x1024>', '-quality', '90', '-define', 'webp:use-sharp-yuv=true', dest])

rmSync(work, { force: true })
const final = size(dest)
console.log(`${path.relative(ROOT, src)} → ${game}/${panel}.webp`)
for (const s of steps) console.log(`  ${s}`)
console.log(`  ${final.w}×${final.h} (${(final.w / final.h).toFixed(2)}:1)`)
console.log(flags.has('--dry-run') ? `  dry run — written to ${path.relative(ROOT, dest)} for a look, nothing installed` : `  installed`)
