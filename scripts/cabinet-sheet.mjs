#!/usr/bin/env node
// Cut a filled-in sheet template into every panel of one cabinet.
//
//   node scripts/cabinet-sheet.mjs ext/turbo-radrun.png radrun --dry-run
//   node scripts/cabinet-sheet.mjs ext/turbo-radrun.png radrun
//   node scripts/cabinet-sheet.mjs ext/turbo-radrun.png radrun --only marquee,bezel
//
// The companion to `cabinet-template.mjs`: you hand a generator art-templates/sheet.png with a
// reference picture, it paints every panel into the slots, and this takes them back out.
//
// The panels are *found*, not assumed — see scripts/lib/sheet.mjs. Each one is artwork on the
// template's flat grey, so the islands of not-grey are the panels, and each island is matched to the
// slot it sits nearest. That survives a generator returning its own canvas shape, which they do, and
// it cuts a panel drawn a little inside its slot to the artwork rather than to the slot. Pass
// --slots to cut by sheet.json's fractions instead, which is exact for a sheet that came back at the
// template's own 4:3 and wrong for one that did not.
//
// --dry-run writes a contact sheet to shots/ with every cut panel side by side, which is how you
// check what it found before anything is installed.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { knobs, reflowBezel } from './lib/bezel.mjs'
import { conformFlank } from './lib/flank.mjs'
import { detectPanels, matchSlots } from './lib/sheet.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATES = path.join(ROOT, 'apps/arcade/art-templates')
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
const onlyArg = args.find((a) => a.startsWith('--only='))?.slice(7) ?? (args.includes('--only') ? args[args.indexOf('--only') + 1] : '')
const positional = args.filter((a) => !a.startsWith('--') && a !== onlyArg)
const [src, game] = positional

if (!src || !game || !GAMES.includes(game)) {
  console.error(`usage: node scripts/cabinet-sheet.mjs <filled-sheet> <${GAMES.join('|')}> [--dry-run] [--only marquee,bezel] [--slots]

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
const outDir = flags.has('--dry-run') ? path.join(ROOT, 'shots', `cabinet-${game}`) : path.join(ROOT, 'apps/arcade/public/cabinets', game)
mkdirSync(outDir, { recursive: true })

/** Where each panel is in the sheet, however the sheet came back. */
function boxes() {
  if (flags.has('--slots')) {
    const got = size(src)
    const want = layout.canvas.w / layout.canvas.h
    const have = got.w / got.h
    let work = src
    if (Math.abs(have - want) > 0.02) {
      work = path.join(ROOT, 'shots', `.cabinet-sheet-${game}.png`)
      mkdirSync(path.dirname(work), { recursive: true })
      const box = have > want ? { w: Math.round(got.h * want), h: got.h } : { w: got.w, h: Math.round(got.w / want) }
      magick([src, '-crop', `${box.w}x${box.h}+${Math.round((got.w - box.w) / 2)}+${Math.round((got.h - box.h) / 2)}`, '+repage', work])
      console.log(`came back ${got.w}×${got.h} (${have.toFixed(2)}:1) — centre-cropped to the sheet's ${want.toFixed(2)}:1`)
    }
    const sheet = size(work)
    const out = new Map()
    for (const [name, slot] of Object.entries(layout.slots)) {
      out.set(name, {
        x: Math.round(slot.x * sheet.w),
        y: Math.round(slot.y * sheet.h),
        w: Math.round(slot.w * sheet.w),
        h: Math.round(slot.h * sheet.h),
        trim: true,
      })
    }
    return { work, found: out }
  }
  const { panels, sheet } = detectPanels(src)
  const found = matchSlots(panels, layout.slots)
  console.log(`came back ${sheet.w}×${sheet.h} (${(sheet.w / sheet.h).toFixed(2)}:1) — found ${found.size} of ${Object.keys(layout.slots).length} panels on it`)
  const missing = Object.keys(layout.slots).filter((n) => !found.has(n))
  if (missing.length) console.log(`  nothing where ${missing.join(' or ')} should be — that panel is left as it was`)
  return { work: src, found }
}

console.log(`${path.relative(ROOT, src)} → ${game}`)
const { work, found } = boxes()
const cut = []
for (const [name, box] of found) {
  if (only && !only.has(name)) continue
  const out = path.join(outDir, `${name}.webp`)
  const crop = `${box.w}x${box.h}+${box.x}+${box.y}`
  if (name === 'bezel') {
    // The one panel with a hole in it, and no generator puts that hole where the cabinet has one —
    // see scripts/lib/bezel.mjs. Cut it whole and hand it to the fitter, which finds the opening
    // that was drawn and re-lays the border around the opening that exists.
    const raw = path.join(ROOT, 'shots', `.cabinet-bezel-${game}.png`)
    mkdirSync(path.dirname(raw), { recursive: true })
    magick([work, '-crop', crop, '+repage', raw])
    const fit = reflowBezel(raw, out, knobs(path.join(TEMPLATES, 'bezel.json'), game))
    rmSync(raw, { force: true })
    cut.push(out)
    const note = fit.mirrored.length ? `  ← nothing drawn on the ${fit.mirrored.join(' or ')}, mirrored from the opposite side` : ''
    console.log(`  ${name.padEnd(11)} ${fit.size.w}×${fit.size.h} — fitted to the cabinet's opening${note}`)
    continue
  }
  if (name === 'side-left' || name === 'side-right') {
    // A generator follows the outline the way a painter follows a reference, not the way a cutter
    // follows a template — near enough that the artwork's own painted edge lands a few percent off
    // the machine's, which shows as bare body along the bottom hem. Conform it; see lib/flank.mjs.
    const raw = path.join(ROOT, 'shots', `.cabinet-${name}-${game}.png`)
    mkdirSync(path.dirname(raw), { recursive: true })
    magick([work, '-crop', crop, '+repage', raw])
    const fit = conformFlank(raw, out, { mirror: name === 'side-left' })
    rmSync(raw, { force: true })
    cut.push(out)
    console.log(`  ${name.padEnd(11)} ${fit.size.w}×${fit.size.h} — conformed to the machine's outline, ${((fit.stretch - 1) * 100).toFixed(0)}% mean stretch`)
    continue
  }
  const args = [work, '-crop', crop, '+repage']
  // Only the fraction path needs trimming: it cuts the slot, so a panel drawn inside one keeps the
  // template's grey around it. A found panel is already exactly its own artwork.
  if (box.trim) args.push('-fuzz', '6%', '-trim', '+repage')
  // sharp-yuv: saturated line art through webp's usual chroma subsampling comes back with cyan and
  // magenta fringes on every black outline, and the bloom in the lobby finds every one of them.
  magick([...args, '-resize', '1024x1024>', '-quality', '90', '-define', 'webp:use-sharp-yuv=true', out])
  const final = size(out)
  cut.push(out)
  console.log(`  ${name.padEnd(11)} ${final.w}×${final.h} (${(final.w / final.h).toFixed(2)}:1)`)
}

if (flags.has('--dry-run')) {
  const contact = path.join(ROOT, 'shots', `cabinet-${game}-sheet.png`)
  // Each panel padded into an even cell, so a contact sheet of five different shapes reads straight.
  magick([...cut, '-background', '#202020', '-resize', '360x360', '-gravity', 'center', '-extent', '380x380', '+append', contact])
  console.log(`  dry run — panels in ${path.relative(ROOT, outDir)}, contact sheet ${path.relative(ROOT, contact)}`)
  console.log(`  install them with the same command without --dry-run`)
} else {
  console.log(`  installed — reload the arcade`)
}

if (work !== src) rmSync(work, { force: true })
