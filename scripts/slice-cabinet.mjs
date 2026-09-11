#!/usr/bin/env node
// Cut cabinet panels out of a generated art sheet into apps/arcade/public/cabinets/<game>/.
//
//   node scripts/slice-cabinet.mjs ext/stuntin.jpeg stuntin
//   node scripts/slice-cabinet.mjs ext/apex.jpeg apex --dry-run
//
// Two sheet layouts are understood:
//
//   sheet    the three-panel presentation sheet the image generator keeps producing — a flat
//            marquee top left, cabinet photographs filling the rest, white gutters between. Only
//            the marquee is flat enough to use as a texture, so only the marquee is taken.
//   panels   the flat texture sheet described in apps/arcade/ART.md: finished artwork panels on a
//            bright magenta field, which is what we actually want for the sides, control panel and
//            bezel. Every island of non-magenta becomes a panel, assigned by shape.
//
// The layout is detected, or forced with --layout. Everything runs through ImageMagick's CLI; there
// is no image library in this repo and one panel every few days does not justify adding one.

import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const MAGENTA_HUE = { rMin: 180, gMax: 110, bMin: 180 }
/** Below this fraction of the sheet, an island is a speck rather than a panel. */
const MIN_ISLAND = 0.01

function magick(args) {
  return execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
}

function size(file) {
  const [w, h] = magick([file, '-format', '%w %h', 'info:']).trim().split(/\s+/).map(Number)
  return { w, h }
}

/**
 * A downscaled greyscale/colour grid of the sheet. Detection works on this rather than the full
 * image: a 2816-wide JPEG takes seconds to enumerate and tells you nothing a 256-wide one doesn't.
 */
function grid(file, cols = 256) {
  const { w, h } = size(file)
  const rows = Math.max(1, Math.round((cols * h) / w))
  const txt = magick([file, '-resize', `${cols}x${rows}!`, '-depth', '8', 'txt:-'])
  const px = new Uint8Array(cols * rows * 3)
  for (const line of txt.split('\n')) {
    const m = /^(\d+),(\d+): \((\d+),(\d+),(\d+)/.exec(line)
    if (!m) continue
    const i = (Number(m[2]) * cols + Number(m[1])) * 3
    px[i] = Number(m[3])
    px[i + 1] = Number(m[4])
    px[i + 2] = Number(m[5])
  }
  return { px, cols, rows, w, h }
}

const isMagenta = (g, i) => g.px[i] >= MAGENTA_HUE.rMin && g.px[i + 1] <= MAGENTA_HUE.gMax && g.px[i + 2] >= MAGENTA_HUE.bMin

function detectLayout(g) {
  let magentaCount = 0
  for (let i = 0; i < g.cols * g.rows * 3; i += 3) if (isMagenta(g, i)) magentaCount++
  return magentaCount / (g.cols * g.rows) > 0.12 ? 'panels' : 'sheet'
}

// --- sheet layout: find the top-left panel bounded by the white gutters --------------------------

/**
 * One row or column of the sheet at full resolution, as brightness. The gutter between panels is
 * only about ten pixels wide, so it vanishes entirely from a downscaled grid — this has to be read
 * at native size, which is why it reads a single line and not the whole image.
 */
function line(file, along, at, length) {
  const geom = along === 'x' ? `${length}x1+0+${at}` : `1x${length}+${at}+0`
  const txt = magick([file, '-crop', geom, '+repage', '-colorspace', 'Gray', '-depth', '8', 'txt:-'])
  const out = new Uint8Array(length)
  for (const l of txt.split('\n')) {
    const m = /^(\d+),(\d+): \((\d+)/.exec(l)
    if (m) out[along === 'x' ? Number(m[1]) : Number(m[2])] = Number(m[3])
  }
  return out
}

/** Where the first run of at least `minRun` near-white pixels starts, past `from`. */
function firstGutter(values, from, minRun = 4) {
  let run = 0
  for (let i = 0; i < values.length; i++) {
    if (values[i] >= 236) {
      run++
      if (run >= minRun && i - run + 1 >= from) return i - run + 1
    } else run = 0
  }
  return values.length
}

function marqueeBox(file, w, h) {
  // Every sample is a median of several lines, because a bright patch of artwork — a sun, a chrome
  // letter — reads exactly like a gutter on any one line, and because the gutter itself goes grey
  // in places where the neighbouring photograph bleeds into it.
  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1]

  // Bottom first, sampling only columns well inside the left-hand panel — its right edge is not
  // known yet, but on every sheet this generator makes the left column is at least a third of the
  // width, so anything under a quarter is safe.
  const bottom = median([0.06, 0.12, 0.2, 0.28].map((f) => firstGutter(line(file, 'y', Math.round(w * f), h), h * 0.25)))

  // Now the right edge, sampling only rows that actually fall inside the marquee.
  const right = median([0.15, 0.3, 0.45, 0.6, 0.75].map((f) => firstGutter(line(file, 'x', Math.round(bottom * f), w), w * 0.25)))

  return { x: 0, y: 0, w: right, h: bottom }
}

// --- panels layout: flood the magenta, take what's left ------------------------------------------

function islands(g) {
  const seen = new Uint8Array(g.cols * g.rows)
  const out = []
  const stack = []
  for (let start = 0; start < g.cols * g.rows; start++) {
    if (seen[start] || isMagenta(g, start * 3)) continue
    let minX = g.cols, minY = g.rows, maxX = -1, maxY = -1, area = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const c = stack.pop()
      const cx = c % g.cols
      const cy = (c / g.cols) | 0
      area++
      if (cx < minX) minX = cx
      if (cx > maxX) maxX = cx
      if (cy < minY) minY = cy
      if (cy > maxY) maxY = cy
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue
        const n = ny * g.cols + nx
        if (seen[n] || isMagenta(g, n * 3)) continue
        seen[n] = 1
        stack.push(n)
      }
    }
    if (area / (g.cols * g.rows) >= MIN_ISLAND) out.push({ minX, minY, maxX, maxY, area })
  }
  const sx = g.w / g.cols
  const sy = g.h / g.rows
  return out.map((b) => ({
    x: Math.round(b.minX * sx),
    y: Math.round(b.minY * sy),
    w: Math.round((b.maxX - b.minX + 1) * sx),
    h: Math.round((b.maxY - b.minY + 1) * sy),
  }))
}

/** Assign islands to panel names by the shape each panel is meant to be. */
function assign(boxes) {
  const want = [
    { name: 'panel', aspect: 21 / 9 },
    { name: 'marquee', aspect: 16 / 9 },
    { name: 'bezel', aspect: 4 / 3 },
    { name: 'side', aspect: 9 / 16 },
  ]
  const free = boxes.slice()
  const out = {}
  // Most distinctive shape first, so the two wide panels can't both grab the same island.
  for (const { name, aspect } of want) {
    if (!free.length) break
    let best = 0
    let bestErr = Infinity
    free.forEach((b, i) => {
      const err = Math.abs(Math.log(b.w / b.h / aspect))
      if (err < bestErr) {
        bestErr = err
        best = i
      }
    })
    out[name] = free.splice(best, 1)[0]
  }
  return out
}

// --- main ----------------------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const positional = argv.filter((a) => !a.startsWith('--'))
const [src, game] = positional

if (!src || !game) {
  console.error('usage: node scripts/slice-cabinet.mjs <sheet.jpeg> <radrun|stuntin|apex> [--layout=sheet|panels] [--only=marquee,side] [--dry-run]')
  process.exit(2)
}
if (!existsSync(src)) {
  console.error(`no such sheet: ${src}`)
  process.exit(2)
}

const dryRun = flags.has('--dry-run')
const only = opt('only', '')
  .split(',')
  .filter(Boolean)
const outDir = path.join('apps/arcade/public/cabinets', game)

const g = grid(src)
const layout = opt('layout', detectLayout(g))
console.log(`${src} — ${g.w}×${g.h}, layout: ${layout}`)

const boxes = layout === 'panels' ? assign(islands(g)) : { marquee: marqueeBox(src, g.w, g.h) }
if (layout === 'sheet') {
  console.log('  (a presentation sheet: only the marquee is flat artwork — see apps/arcade/ART.md for')
  console.log('   the prompt that produces the side, control-panel and bezel textures)')
}

if (!dryRun) mkdirSync(outDir, { recursive: true })

for (const [name, box] of Object.entries(boxes)) {
  if (only.length && !only.includes(name)) continue
  if (!box || box.w < 32 || box.h < 32) {
    console.log(`  ${name.padEnd(8)} — not found`)
    continue
  }
  const out = path.join(outDir, `${name}.webp`)
  const aspect = (box.w / box.h).toFixed(3)
  console.log(`  ${name.padEnd(8)} ${String(box.w).padStart(5)}×${String(box.h).padEnd(5)} (${aspect}:1) → ${dryRun ? '(dry run)' : out}`)
  if (dryRun) continue
  // Cap the long edge at 1024: these are read at a few hundred pixels on screen, and a cabinet
  // carrying four 2k textures costs more VRAM than the whole rest of the lobby.
  magick([src, '-crop', `${box.w}x${box.h}+${box.x}+${box.y}`, '+repage', '-resize', '1024x1024>', '-quality', '88', out])
}
