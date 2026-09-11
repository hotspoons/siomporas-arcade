#!/usr/bin/env node
// Measure every cabinet's artwork against the machine it goes on.
//
//   node scripts/cabinet-check.mjs            # every game, every panel
//   node scripts/cabinet-check.mjs radrun     # one game
//   just art-check
//
// Artwork that is *nearly* right is the whole problem with generating it: a flank a few percent out
// shows as a pale hem along the bottom of a cabinet, a marquee of the wrong shape makes one machine
// taller than the two beside it, and a bezel whose hole is elsewhere puts the frame across the
// glass. None of that is visible in a contact sheet and all of it is obvious on the machine, a day
// later, from the far end of the room.
//
// So it is measured. Every line of this report maps to a row of the remediation table in
// apps/arcade/ART.md: what it means, what to ask the generator for, and what to run.
//
// Exit code 1 if anything FAILS, so it can gate a commit. WARN is "worth a look", not "broken".

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FLANK, PANELS } from './lib/fit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CABINETS = path.join(ROOT, 'apps/arcade/public/cabinets')
/** How far apart two marquees can be before the machines they sit on look uneven. */
const MARQUEE_SPREAD = 0.04

function magick(args) {
  return execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
}

function size(file) {
  const [w, h] = magick([file, '-format', '%w %h', 'info:']).trim().split(/\s+/).map(Number)
  return { w, h }
}

/** Is a pixel the template's flat grey field rather than artwork? */
const isField = (r, g, b) => Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && Math.abs(r - b) < 14 && r > 74 && r < 168

/** Sample a panel onto a grid and say, per cell, whether it is artwork. */
function artMask(file, cols, rows) {
  const txt = magick([file, '-resize', `${cols}x${rows}!`, '-depth', '8', 'txt:-'])
  const mask = new Uint8Array(cols * rows)
  for (const line of txt.split('\n')) {
    const m = /^(\d+),(\d+): \((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(line)
    if (!m) continue
    if (!isField(Number(m[3]), Number(m[4]), Number(m[5]))) mask[Number(m[2]) * cols + Number(m[1])] = 1
  }
  return mask
}

/** Is a point inside a polygon given in fractions? */
function inside(poly, u, v) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

const findings = []
function say(game, panel, level, text, fix) {
  findings.push({ game, panel, level, text, fix })
}

const games = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const list = (games.length ? games : readdirSync(CABINETS)).filter((g) => existsSync(path.join(CABINETS, g)))

const marquees = new Map()
for (const game of list) {
  const dir = path.join(CABINETS, game)

  for (const [panel, want] of Object.entries(PANELS)) {
    const file = path.join(dir, `${panel}.webp`)
    if (!existsSync(file)) {
      // An attract still is optional where a loop was filmed; everything else is not.
      const loop = existsSync(path.join(dir, 'attract.webm'))
      if (panel === 'attract' && loop) continue
      say(game, panel, 'FAIL', 'missing', `generate it — apps/arcade/ART.md, "${panel}"`)
      continue
    }
    const got = size(file)
    const aspect = got.w / got.h
    const off = Math.abs(aspect - want.aspect) / want.aspect
    if (off > want.tolerance) {
      say(
        game,
        panel,
        'FAIL',
        `${got.w}×${got.h} is ${aspect.toFixed(2)}:1, wants ${want.aspect.toFixed(2)}:1 (${(off * 100).toFixed(0)}% out)`,
        'ask again with the template attached, or re-cut the sheet',
      )
    } else if (off > want.tolerance / 2 && panel !== 'panel') {
      // The deck says something more useful about itself below.
      say(game, panel, 'WARN', `${aspect.toFixed(2)}:1 against ${want.aspect.toFixed(2)}:1`, 'usable; the fitter takes up the difference')
    }
    if (Math.max(got.w, got.h) < want.minEdge) {
      say(game, panel, 'WARN', `${Math.max(got.w, got.h)}px on its long edge, wants ${want.minEdge}`, 'ask for a larger image; this one is seen close up')
    }
    if (panel === 'marquee') marquees.set(game, aspect)

    // The deck: artwork is fitted inside its face rather than stretched onto it, so what matters is
    // not the shape it came back as but how much of the panel it ends up covering.
    if (panel === 'panel') {
      const fills = Math.min(aspect, want.aspect) / Math.max(aspect, want.aspect)
      if (fills < 0.55) {
        say(game, panel, 'WARN', `artwork is ${aspect.toFixed(1)}:1, so it covers ${(fills * 100).toFixed(0)}% of the deck and the rest is painted body`, 'ask for one that fills the control panel slot corner to corner')
      }
    }

    // The flanks: how much of the machine the artwork actually covers. The rest is carried out from
    // its own edges by scripts/lib/flank.mjs, which is fine in small doses and a smear in large ones.
    if (panel === 'side-left' || panel === 'side-right') {
      const cols = 120
      const rows = Math.round(cols / FLANK.aspect)
      const mask = artMask(file, cols, rows)
      const poly = panel === 'side-left' ? FLANK.outline.map(([x, y]) => [1 - x, y]) : FLANK.outline
      let machine = 0
      let covered = 0
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (!inside(poly, (x + 0.5) / cols, (y + 0.5) / rows)) continue
          machine++
          if (mask[y * cols + x]) covered++
        }
      }
      const pc = covered / machine
      if (pc < 0.9) {
        say(game, panel, 'FAIL', `artwork covers ${(pc * 100).toFixed(0)}% of the machine`, 'the drawn shape is well off the template — ask again, showing it the side template')
      } else if (pc < 0.97) {
        say(game, panel, 'WARN', `artwork covers ${(pc * 100).toFixed(0)}% of the machine`, 'the edges are carried out over the rest; fine unless you can see it')
      }
    }

    // The bezel: after fitting, the middle must be dark, because the glass sits in front of it and
    // anything bright there is a frame drawn over the screen.
    if (panel === 'bezel') {
      const cols = 60
      const rows = Math.round(cols / PANELS.bezel.aspect)
      const txt = magick([file, '-resize', `${cols}x${rows}!`, '-depth', '8', 'txt:-'])
      let lit = 0
      let n = 0
      for (const line of txt.split('\n')) {
        const m = /^(\d+),(\d+): \((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(line)
        if (!m) continue
        const u = (Number(m[1]) + 0.5) / cols
        const v = (Number(m[2]) + 0.5) / rows
        const h = PANELS.bezel.hole ?? null
        const hole = h ?? { x0: 0.25, y0: 0.22, x1: 0.75, y1: 0.78 }
        if (u < hole.x0 || u > hole.x1 || v < hole.y0 || v > hole.y1) continue
        n++
        if ((Number(m[3]) + Number(m[4]) + Number(m[5])) / 3 > 40) lit++
      }
      if (n && lit / n > 0.08) {
        say(game, panel, 'FAIL', `${((lit / n) * 100).toFixed(0)}% of the area behind the glass is not dark`, 'run scripts/cabinet-bezel.mjs on the source again — the opening was detected in the wrong place')
      }
    }
  }

  if (!existsSync(path.join(dir, 'attract.webm'))) {
    say(game, 'attract', 'WARN', 'no loop filmed', 'node scripts/capture-attract.mjs ' + game)
  }
}

// One marquee of a different shape is one machine of a different height.
if (marquees.size > 1) {
  const values = [...marquees.values()]
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  if ((hi - lo) / lo > MARQUEE_SPREAD) {
    const tall = [...marquees].sort((a, b) => a[1] - b[1])[0][0]
    say('all', 'marquee', 'WARN', `marquees run ${lo.toFixed(2)}:1 to ${hi.toFixed(2)}:1, so the machines are different heights (${tall} is the tallest)`, 'ask for 16:9 marquees, or accept a row of uneven machines')
  }
}

const width = Math.max(...findings.map((f) => f.game.length + f.panel.length), 12)
for (const f of findings) {
  const tag = `${f.game}/${f.panel}`.padEnd(width + 2)
  console.log(`${f.level === 'FAIL' ? 'FAIL' : 'warn'}  ${tag} ${f.text}`)
  console.log(`      ${' '.repeat(width + 2)} → ${f.fix}`)
}
const fails = findings.filter((f) => f.level === 'FAIL').length
const warns = findings.length - fails
console.log(
  findings.length
    ? `\n${fails} to fix, ${warns} worth a look, over ${list.length} cabinet${list.length === 1 ? '' : 's'}. See apps/arcade/ART.md.`
    : `every panel on ${list.length} cabinet${list.length === 1 ? '' : 's'} fits the machine.`,
)
process.exit(fails ? 1 : 0)
