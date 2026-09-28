#!/usr/bin/env node
// Close the holes the chroma key punches through a subject's GLAZING.
//
//   node tools/assetlib/fillholes.mjs tools/assetlib/out/civic-eg/view-1-keyed.png
//
// WHY THIS EXISTS. The keyer is correct and this is not a bug in it: a car's windows genuinely
// show the backdrop, through them and reflected in them, so green dominance is genuinely high
// there and the mask genuinely says "backdrop". The cut-out that results is a car with its
// windscreen, side glass and hatch missing.
//
// TRELLIS then reconstructs THROUGH those holes and invents an interior to fill them, which is
// where the grey shards, the mottled roofs and the purple windscreens come from. Measured across
// the first roster: civic-eg lost 26,317 px of glazing — 12.5% of the whole subject, in blobs up
// to 11,244 px — while nsx-na1 lost only 3,728 px, and the NSX is far and away the cleanest
// reconstruction in the set. The correlation is the diagnosis.
//
// THE TEST IS CONNECTIVITY, NOT COLOUR. Real background reaches the edge of the frame; a window
// does not. So: flood the transparent region inward from a border that is known to be background,
// and any transparent pixel the flood never reaches is enclosed by subject and must be subject.
//
// This is deliberately safe for the shapes that SHOULD stay open. The gap beneath a rear wing on
// stalks, the slots in a slatted engine cover and the space between a spoiler and a boot lid are
// all open at their ends, so the flood reaches them and they survive. Only a fully enclosed region
// is filled — which is exactly what a pane of glass is.
//
// The filled pixels keep the DESPILLED backdrop colour, and that turns out to be the right answer
// rather than a compromise: despill takes chroma green to srgb(46,55,64) and chroma magenta to
// near black, so the glass comes back as dark blue-grey or black tint. Nothing has to be painted.

import { execFileSync } from 'node:child_process'
import { renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const magick = (args) => execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 }).trim()

/**
 * Fill every enclosed transparent region of an RGBA cut-out, in place unless `out` is given.
 * Returns { before, after, filled } as percentages of the frame.
 */
export function fillHoles(src, out = src) {
  const tmp = `${out}.holes.png`
  const before = Number(magick([src, '-alpha', 'extract', '-format', '%[fx:mean*100]', 'info:'])) || 0

  magick([
    src, '-alpha', 'extract',
    // A one-pixel frame that is certainly background, so the flood has somewhere to start even
    // when the subject runs off the edge — which it usually does: these are framed tight.
    '-bordercolor', 'black', '-border', '1',
    // Paint the reachable background mid-grey. What stays pure black is enclosed.
    '-fill', 'gray50', '-draw', 'color 0,0 floodfill',
    // Reachable background -> transparent, everything else (subject AND enclosed holes) -> opaque.
    '-fx', 'abs(u-0.5)<0.12 ? 0 : 1',
    '-shave', '1x1',
    tmp,
  ])
  // NEVER COMPOSITE A FILE ONTO ITSELF. When `out === src` ImageMagick does not reliably honour
  // the write, and it does not complain: the call succeeds, the log prints a filled figure taken
  // from the in-memory result, and the file on disk is still the original. That shipped four cars
  // whose build log said "holes filled" and whose alpha was untouched — caught only because the
  // hole count was re-measured from disk afterwards rather than trusted from the log.
  const staged = `${out}.staged.png`
  magick([src, tmp, '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', staged])
  const after = Number(magick([staged, '-alpha', 'extract', '-format', '%[fx:mean*100]', 'info:'])) || 0
  renameSync(staged, out)
  rmSync(tmp, { force: true })

  // Assert the mechanism. Filling holes can only ADD opacity, so a result that did not grow when
  // holes were present means the write was lost again.
  const holes = +(after - before).toFixed(2)
  const check = Number(magick([out, '-alpha', 'extract', '-format', '%[fx:mean*100]', 'info:'])) || 0
  if (Math.abs(check - after) > 0.01) throw new Error(`fillHoles: wrote ${after}% but ${path.basename(out)} reads ${check}%`)
  return { before: +before.toFixed(2), after: +after.toFixed(2), filled: holes }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (!files.length) { console.error('usage: fillholes.mjs <keyed.png> [...]'); process.exit(1) }
  for (const f of files) {
    const r = fillHoles(f, process.argv.includes('--in-place') ? f : f.replace(/\.png$/, '-filled.png'))
    console.log(`${path.basename(path.dirname(f))}  ink ${r.before}% -> ${r.after}%  (+${r.filled})`)
  }
}
