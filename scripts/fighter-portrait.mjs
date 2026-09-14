#!/usr/bin/env node
// Cut a generated select-screen portrait down to the 96x96 the game draws.
//
//   node scripts/fighter-portrait.mjs ext/kestrel-portrait.png kestrel
//   node scripts/fighter-portrait.mjs ext/kestrel-portrait.png kestrel --check   # look at 18px too
//
// The sheets go through fighter-sheet.mjs and then pack-frames.mjs, but a portrait is one square
// still with no grid and no anchor, so it has its own two-step: key it, then fit it to the box the
// renderer draws. It lands next to the atlas, where loadCharacterArt finds it with no config entry:
//
//   apps/fighter/public/assets/crown/chars/<id>/portrait.png
//
// THE SIZE THAT MATTERS IS 18 PIXELS, not 96. The portrait is drawn beside the health bar at
// eighteen pixels square, which is where a mugshot either reads or turns to mush — `--check` writes
// a magnified 18px preview next to the output so that can be judged rather than assumed. What
// survives there is the silhouette and two strong colours; anything finer is decoration.
//
// TWO KEY COLOURS, not one. The generator often paints its own border just inside the square, in a
// different green from the field — so a single sample taken near the corner lands on the border,
// keys the border alone, and leaves the whole background behind. We sample near the corner AND well
// inside, and key both; when they are the same colour the second pass costs nothing.
//
// Alpha is easy to lose here: `-extent` pads with the current background colour, and padding an
// image with an opaque colour quietly throws away the transparency that was the entire point.
// Hence `-background none` before the resize, and the coverage figure printed at the end — a
// portrait that comes back 100% opaque has not been keyed, whatever it looks like.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 96

const magick = (args) => execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 })

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const flag = (f, d) => {
  const i = argv.indexOf(`--${f}`)
  return i === -1 ? d : argv[i + 1]
}
const [src, character] = argv.filter((a) => !a.startsWith('--') && a !== flag('fuzz', null))

if (!src || !character) {
  console.error(`usage: node scripts/fighter-portrait.mjs <generated.png> <character-id> [--fuzz N] [--check]

  --fuzz N   key tolerance, percent (default 16)
  --check    also write a magnified 18px preview to shots/, which is the size that decides`)
  process.exit(1)
}
if (!existsSync(src)) {
  console.error(`fighter-portrait: no such file: ${src}`)
  process.exit(1)
}

const fuzz = Number(flag('fuzz', '16'))
const pixel = (x, y) => magick([src, '-format', `%[pixel:p{${x},${y}}]`, 'info:']).trim()

const { w } = (() => {
  const [a, b] = magick([src, '-format', '%w %h', 'info:']).trim().split(/\s+/).map(Number)
  return { w: a, h: b }
})()

// Near the corner catches a border if there is one; a good way in catches the field behind the
// figure. On a clean square both samples are the same colour and the second pass is a no-op.
const keys = [...new Set([pixel(12, 12), pixel(Math.round(w * 0.15), Math.round(w * 0.15))])]

const outDir = path.join(ROOT, 'apps/fighter/public/assets/crown/chars', character)
mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, 'portrait.png')

const args = [src, '-alpha', 'set']
for (const k of keys) args.push('-fuzz', `${fuzz}%`, '-transparent', k)
args.push(
  '-channel', 'A', '-blur', '0x0.5', '-level', '40%,60%', '+channel',
  '-trim', '+repage',
  '-background', 'none', '-resize', `${SIZE}x${SIZE}`, '-gravity', 'center', '-extent', `${SIZE}x${SIZE}`,
  out,
)
magick(args)

const coverage = Number(magick([out, '-format', '%[fx:mean.a*100]', 'info:']))
const warn = coverage > 95 ? '  <- nothing was keyed; check the background' : coverage < 10 ? '  <- almost nothing survived' : ''
console.log(`${path.relative(ROOT, out)}  ${SIZE}x${SIZE}  keyed ${keys.join(' + ')}  ${coverage.toFixed(0)}% opaque${warn}`)

if (has('check')) {
  const preview = path.join(ROOT, 'shots', `portrait-${character}-18px.png`)
  mkdirSync(path.dirname(preview), { recursive: true })
  magick([out, '-resize', '18x18', '-background', '#2a2a2a', '-alpha', 'remove', '-filter', 'point', '-resize', '700%', preview])
  console.log(`  ${path.relative(ROOT, preview)}  <- what the player actually sees, magnified`)
}
