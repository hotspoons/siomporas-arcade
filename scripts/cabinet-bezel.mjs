#!/usr/bin/env node
// Fit one bezel to the cabinet, on its own.
//
//   node scripts/cabinet-bezel.mjs ext/radrun-bezel.jpeg radrun --dry-run
//   node scripts/cabinet-bezel.mjs ext/radrun-bezel.jpeg radrun --mirror right,bottom
//
// `cabinet-sheet.mjs` and `cabinet-art.mjs` already run this on every bezel they install; this is
// for when one of them came out wrong and you want to try a correction without re-cutting the whole
// sheet. Corrections that stick belong in apps/arcade/art-templates/bezel.json, so that the next
// regenerated sheet gets them for free. See apps/arcade/ART.md.
//
// --dry-run writes the fitted panel and a before/after pair into shots/ instead of installing it.

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { knobs, reflowBezel } from './lib/bezel.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GAMES = ['radrun', 'stuntin', 'apex']

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
}
const dry = args.includes('--dry-run')
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !args[i - 1].includes('=') && args[i - 1] !== '--dry-run'))
const [src, game] = positional

if (!src || !game || !GAMES.includes(game)) {
  console.error(`usage: node scripts/cabinet-bezel.mjs <bezel-image> <${GAMES.join('|')}> [--dry-run]
                [--opening x0,y0,x1,y1] [--mirror left,top,right,bottom] [--overlap 0.022] [--grow 0]`)
  process.exit(1)
}

const opts = { ...knobs(path.join(ROOT, 'apps/arcade/art-templates/bezel.json'), game) }
if (flag('opening')) opts.opening = flag('opening').split(',').map(Number)
if (flag('mirror')) opts.mirror = flag('mirror').split(',')
if (flag('overlap')) opts.overlap = Number(flag('overlap'))
if (flag('grow')) opts.grow = Number(flag('grow'))

const out = dry ? path.join(ROOT, 'shots', `cabinet-${game}-bezel.webp`) : path.join(ROOT, 'apps/arcade/public/cabinets', game, 'bezel.webp')
mkdirSync(path.dirname(out), { recursive: true })
const r = reflowBezel(src, out, opts)

const pc = (v) => `${Math.round(v * 100)}%`
console.log(`${path.relative(ROOT, src)} → ${game}/bezel.webp`)
console.log(`  opening ${r.detected}: ${pc(r.opening.x0)},${pc(r.opening.y0)} → ${pc(r.opening.x1)},${pc(r.opening.y1)}`)
if (r.mirrored.length) console.log(`  no border drawn on the ${r.mirrored.join(' or ')} — mirrored from the opposite side`)
console.log(`  ${r.size.w}×${r.size.h}, fitted to the cabinet's opening`)

if (dry) {
  const pair = path.join(ROOT, 'shots', `cabinet-${game}-bezel.png`)
  execFileSync('magick', [src, out, '-background', '#202020', '-resize', '480x480', '-gravity', 'center', '-extent', '500x500', '+append', pair])
  console.log(`  dry run — ${path.relative(ROOT, out)}, before/after ${path.relative(ROOT, pair)}`)
} else {
  console.log(`  installed — reload the arcade`)
}
