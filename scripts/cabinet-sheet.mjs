#!/usr/bin/env node
// Cut a filled-in sheet template into every panel of one cabinet.
//
//   node scripts/cabinet-sheet.mjs ext/radrun-sheet.jpeg radrun --dry-run
//   node scripts/cabinet-sheet.mjs ext/radrun-sheet.jpeg radrun
//   node scripts/cabinet-sheet.mjs ext/radrun-sheet.jpeg radrun --only marquee,side
//
// The companion to `cabinet-template.mjs`: you hand a generator art-templates/sheet.png with a
// reference picture, it paints every panel into the slots, and this takes them back out.
//
// No detection of any kind. We drew the template, so we know where every slot is — sheet.json holds
// them as fractions of the canvas, and a generator handing back 1536×1152 instead of 2048×1536 does
// not change where a slot is *proportionally*. The one thing that would is a different aspect
// ratio, so if what comes back is not the sheet's shape it gets centre-cropped to it first, and
// says so.
//
// --dry-run writes a contact sheet to shots/ with every cut panel side by side, which is how you
// check the generator kept to the layout before anything is installed.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = path.join(ROOT, 'apps/arcade/art-templates')
const GAMES = ['radrun', 'stuntin', 'apex', 'crown']
/** The two greys the template is drawn in; see cabinet-template.mjs. */
const FIELD = '#7a7a7a'
const SLOT_FIELD = '#8f8f8f'

function magick(args) {
  return execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
}

function size(file) {
  const [w, h] = magick([file, '-format', '%w %h', 'info:']).trim().split(/\s+/).map(Number)
  return { w, h }
}

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const onlyArg = args.find((a) => a.startsWith('--only='))?.slice(7) ?? (args.includes('--only') ? args[args.indexOf('--only') + 1] : '')
const positional = args.filter((a) => !a.startsWith('--') && a !== onlyArg)
const [src, game] = positional

if (!src || !game || !GAMES.includes(game)) {
  console.error(`usage: node scripts/cabinet-sheet.mjs <filled-sheet> <${GAMES.join('|')}> [--dry-run] [--only marquee,side]

Hand a generator apps/arcade/art-templates/sheet.png together with art to match, ask it to fill in
every panel, and run this on what comes back. See apps/arcade/ART.md.`)
  process.exit(1)
}
if (!existsSync(src)) {
  console.error(`cabinet-sheet: no such file: ${src}`)
  process.exit(1)
}

const layout = JSON.parse(readFileSync(path.join(TEMPLATES, 'sheet.json'), 'utf8'))
const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim())) : null

const got = size(src)
const want = layout.canvas.w / layout.canvas.h
const have = got.w / got.h
let work = src

// Same proportions, or make them the same: the slots are fractions, so the shape has to match.
if (Math.abs(have - want) > 0.02) {
  work = path.join(ROOT, 'shots', `.cabinet-sheet-${game}.png`)
  mkdirSync(path.dirname(work), { recursive: true })
  const box = have > want ? { w: Math.round(got.h * want), h: got.h } : { w: got.w, h: Math.round(got.w / want) }
  magick([src, '-crop', `${box.w}x${box.h}+${Math.round((got.w - box.w) / 2)}+${Math.round((got.h - box.h) / 2)}`, '+repage', work])
  console.log(`came back ${got.w}×${got.h} (${have.toFixed(2)}:1) — centre-cropped to the sheet's ${want.toFixed(2)}:1`)
}

const sheet = size(work)
const outDir = flags.has('--dry-run') ? path.join(ROOT, 'shots', `cabinet-${game}`) : path.join(ROOT, 'apps/arcade/public/cabinets', game)
mkdirSync(outDir, { recursive: true })

console.log(`${path.relative(ROOT, src)} → ${game}`)
const cut = []
for (const [name, slot] of Object.entries(layout.slots)) {
  if (only && !only.has(name)) continue
  const box = {
    w: Math.round(slot.w * sheet.w),
    h: Math.round(slot.h * sheet.h),
    x: Math.round(slot.x * sheet.w),
    y: Math.round(slot.y * sheet.h),
  }
  const out = path.join(outDir, `${name}.webp`)
  // Trim before encoding: a generator that fills a slot with a band of art centred in the template's
  // grey leaves that grey in the cut, and it would end up painted on the cabinet. -trim works from
  // the corner pixel, which in that case is the grey; where the art does reach the edges the corner
  // is artwork and busy enough that nothing is taken.
  const cutArgs = [work, '-crop', `${box.w}x${box.h}+${box.x}+${box.y}`, '+repage', '-fuzz', '6%', '-trim', '+repage']
  // A bezel is a frame, so a generator leaves its middle empty — which means it leaves the
  // template's grey there, and that grey would be painted on the cabinet around the screen. The
  // screen is geometry sitting in front of it, so the right colour behind it is black.
  if (name === 'bezel') cutArgs.push('-fuzz', '10%', '-fill', '#0a0a0a', '-opaque', FIELD, '-fuzz', '10%', '-fill', '#0a0a0a', '-opaque', SLOT_FIELD)
  magick([...cutArgs, '-resize', '1024x1024>', '-quality', '88', out])
  const final = size(out)
  const slotAspect = box.w / box.h
  const gotAspect = final.w / final.h
  cut.push(out)
  const note = Math.abs(gotAspect - slotAspect) > 0.15 ? `  ← trimmed back from ${slotAspect.toFixed(2)}:1, the slot was not filled` : ''
  console.log(`  ${name.padEnd(11)} ${final.w}×${final.h} (${gotAspect.toFixed(2)}:1)${note}`)
}

if (flags.has('--dry-run')) {
  const contact = path.join(ROOT, 'shots', `cabinet-${game}-sheet.png`)
  // Each panel padded into an even cell, so a contact sheet of four different shapes reads straight.
  magick([...cut, '-background', '#202020', '-resize', '360x360', '-gravity', 'center', '-extent', '380x380', '+append', contact])
  console.log(`  dry run — panels in ${path.relative(ROOT, outDir)}, contact sheet ${path.relative(ROOT, contact)}`)
  console.log(`  install them with the same command without --dry-run`)
} else {
  console.log(`  installed — reload the arcade`)
}

if (work !== src) rmSync(work, { force: true })
