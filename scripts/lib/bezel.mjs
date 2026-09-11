// Fit a generated bezel to the cabinet's actual opening.
//
// A bezel is the one panel with a hole in it, which makes it the one panel a generator cannot get
// right. Ask for "a frame with the middle kept simple" and what comes back is a frame whose opening
// is wherever it felt like — every sheet so far has pushed it into the bottom-right corner and
// drawn no border on two of the four sides at all. Laid on the cabinet that reads as artwork
// sliding off the machine, because the screen is geometry in a fixed place and the art is not.
//
// So the art is not used as it arrives. It is nine-sliced: find the opening the generator drew,
// take the eight pieces of border around it, and re-lay them around the opening the *cabinet* has —
// corners kept as corners, edges stretched along their run. A side that was never drawn is
// mirrored from the one opposite, which is what makes a half-drawn frame usable at all and reads
// as deliberate, because bezel art is close to symmetric anyway.
//
// Nothing here is per-game until it has to be: the opening is detected, and apps/arcade/art-
// templates/bezel.json only carries corrections for a game the detector got wrong. Regenerating
// artwork therefore means re-running the cutter, not re-tuning anything.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/**
 * The shape of the bezel face and where the glass sits in it, as fractions of the face. Worked out
 * from the cabinet's silhouette — `BEZEL_FIT` in apps/arcade/src/lobby/Cabinet.ts is the same four
 * numbers computed from the geometry itself, and apps/arcade/test/bezel.test.ts fails if the two
 * ever drift apart. The rectangle is symmetric, so image space (y down) needs no flip.
 */
export const FACE = { aspect: 1.4944005, hole: { x0: 0.1987952, y0: 0.1624095, x1: 0.8012048, y1: 0.8375905 } }

/** How far the artwork tucks in under the glass, as a fraction of the panel's width. */
const OVERLAP = 0.022
/** A border thinner than this is one the generator did not draw. Fraction of the shorter side. */
const MIN_BORDER = 0.035
/** What is left behind the glass. It is covered by the screen; it only has to not be grey. */
const DARK = '#050505'
/** The panel is seen from 80 cm away when you lean in, so it is worth more pixels than a flank. */
const OUT_W = 1280

function magick(args) {
  return execFileSync('magick', args, { encoding: 'utf8', maxBuffer: 1 << 28 })
}

function size(file) {
  const [w, h] = magick([file, '-format', '%w %h', 'info:']).trim().split(/\s+/).map(Number)
  return { w, h }
}

/** Per-game corrections, if any have been written down. */
export function knobs(file, game) {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))[game] ?? {}
  } catch {
    return {}
  }
}

/**
 * Where the generator left its hole, as fractions of the image, or null if it drew no hole at all.
 *
 * The opening is the part of a bezel with nothing going on in it, so what is measured is local
 * contrast: a grid of mean standard deviation, thresholded against the picture's own busiest cells.
 * A rectangle is then grown out from the middle while the row or column it is about to swallow is
 * mostly quiet. Flat grey, flat navy and a soft gradient all read as quiet, which is the point —
 * three generators filled the middle three different ways.
 */
export function detectOpening(src, cols = 96, rows = 72) {
  const txt = magick([src, '-colorspace', 'gray', '-statistic', 'StandardDeviation', '5x5', '-resize', `${cols}x${rows}!`, '-depth', '8', 'txt:-'])
  const cell = new Float64Array(cols * rows)
  for (const line of txt.split('\n')) {
    const m = /^(\d+),(\d+): \((\d+)/.exec(line)
    if (m) cell[Number(m[2]) * cols + Number(m[1])] = Number(m[3])
  }
  const sorted = Array.from(cell).sort((a, b) => a - b)
  const busy = sorted[Math.floor(sorted.length * 0.85)]
  const thresh = Math.max(3, busy * 0.22)
  const flat = (x, y) => cell[y * cols + x] <= thresh

  let x0 = Math.floor(cols / 2)
  let x1 = x0
  let y0 = Math.floor(rows / 2)
  let y1 = y0
  if (!flat(x0, y0)) return null

  const runFlat = (cells) => {
    let n = 0
    for (const ok of cells) if (ok) n++
    return n / cells.length >= 0.82
  }
  for (let guard = 0; guard < cols + rows; guard++) {
    let grew = false
    const colCells = (x) => Array.from({ length: y1 - y0 + 1 }, (_, i) => flat(x, y0 + i))
    const rowCells = (y) => Array.from({ length: x1 - x0 + 1 }, (_, i) => flat(x0 + i, y))
    if (x0 > 0 && runFlat(colCells(x0 - 1))) {
      x0--
      grew = true
    }
    if (x1 < cols - 1 && runFlat(colCells(x1 + 1))) {
      x1++
      grew = true
    }
    if (y0 > 0 && runFlat(rowCells(y0 - 1))) {
      y0--
      grew = true
    }
    if (y1 < rows - 1 && runFlat(rowCells(y1 + 1))) {
      y1++
      grew = true
    }
    if (!grew) break
  }
  const area = ((x1 - x0 + 1) / cols) * ((y1 - y0 + 1) / rows)
  // A hole smaller than this is a dark patch of artwork, not an opening.
  if (area < 0.12) return null
  return { x0: x0 / cols, y0: y0 / rows, x1: (x1 + 1) / cols, y1: (y1 + 1) / rows }
}

/**
 * Nine-slice `src` onto the cabinet's bezel and write `out`.
 *
 * Returns what it did, so the caller can print it: whether the opening was detected or given, and
 * which sides had to be mirrored because the generator never drew them.
 */
export function reflowBezel(src, out, opts = {}) {
  const s = size(src)
  const overlap = opts.overlap ?? OVERLAP
  let opening = opts.opening ? { x0: opts.opening[0], y0: opts.opening[1], x1: opts.opening[2], y1: opts.opening[3] } : null
  const detected = opening ? 'given' : 'detected'
  opening = opening ?? detectOpening(src)
  if (!opening) {
    // No hole drawn at all: treat the middle of the picture as one, so the art still becomes a
    // frame rather than being stretched whole across a face that is mostly screen.
    opening = { ...FACE.hole }
  }
  if (opts.shift) {
    opening.x0 += opts.shift[0]
    opening.x1 += opts.shift[0]
    opening.y0 += opts.shift[1]
    opening.y1 += opts.shift[1]
  }
  if (opts.grow) {
    opening.x0 -= opts.grow
    opening.x1 += opts.grow
    opening.y0 -= opts.grow
    opening.y1 += opts.grow
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v))
  for (const k of ['x0', 'y0', 'x1', 'y1']) opening[k] = clamp01(opening[k])

  // The border the generator drew, in source pixels.
  const min = MIN_BORDER * Math.min(s.w, s.h)
  const forced = new Set(opts.mirror ?? [])
  const have = {
    l: Math.round(opening.x0 * s.w),
    r: Math.round((1 - opening.x1) * s.w),
    t: Math.round(opening.y0 * s.h),
    b: Math.round((1 - opening.y1) * s.h),
  }
  const drew = {
    l: have.l >= min && !forced.has('left'),
    r: have.r >= min && !forced.has('right'),
    t: have.t >= min && !forced.has('top'),
    b: have.b >= min && !forced.has('bottom'),
  }
  const mirrored = []
  // A side that was never drawn comes from the one opposite, flipped. If neither side exists, a
  // strip off the edge is taken as-is — ugly, but there is nothing better in the picture.
  const strip = (which, opposite, flipName, extent, from) => {
    if (drew[which]) return { at: from, len: have[which], flip: false }
    if (drew[opposite]) {
      mirrored.push(flipName)
      return { at: which === 'l' || which === 't' ? s[extent] - have[opposite] : 0, len: have[opposite], flip: true }
    }
    const len = Math.round(s[extent] * 0.12)
    return { at: which === 'l' || which === 't' ? 0 : s[extent] - len, len, flip: false }
  }
  const colL = strip('l', 'r', 'left', 'w', 0)
  const colR = strip('r', 'l', 'right', 'w', s.w - have.r)
  const rowT = strip('t', 'b', 'top', 'h', 0)
  const rowB = strip('b', 't', 'bottom', 'h', s.h - have.b)
  // The middle of the source runs between the borders it actually has.
  const midX = { at: drew.l ? have.l : 0, len: (drew.r ? s.w - have.r : s.w) - (drew.l ? have.l : 0) }
  const midY = { at: drew.t ? have.t : 0, len: (drew.b ? s.h - have.b : s.h) - (drew.t ? have.t : 0) }

  // The cabinet's own opening, with the artwork tucked in under the glass all round so no seam can
  // show even if the texture is a pixel out.
  const W = OUT_W
  const H = Math.round(W / FACE.aspect)
  const L = Math.round((FACE.hole.x0 + overlap) * W)
  const R = Math.round((1 - FACE.hole.x1 + overlap) * W)
  const T = Math.round((FACE.hole.y0 + overlap * FACE.aspect) * H)
  const B = Math.round((1 - FACE.hole.y1 + overlap * FACE.aspect) * H)

  const piece = (sx, sy, sw, sh, flop, flip, tx, ty, tw, th) => {
    const a = ['(', src, '-crop', `${Math.max(1, sw)}x${Math.max(1, sh)}+${sx}+${sy}`, '+repage']
    if (flop) a.push('-flop')
    if (flip) a.push('-flip')
    a.push('-resize', `${tw}x${th}!`, ')', '-geometry', `+${tx}+${ty}`, '-composite')
    return a
  }
  const args = [
    '-size', `${W}x${H}`, `xc:${opts.dark ?? DARK}`,
    ...piece(colL.at, rowT.at, colL.len, rowT.len, colL.flip, rowT.flip, 0, 0, L, T),
    ...piece(midX.at, rowT.at, midX.len, rowT.len, false, rowT.flip, L, 0, W - L - R, T),
    ...piece(colR.at, rowT.at, colR.len, rowT.len, colR.flip, rowT.flip, W - R, 0, R, T),
    ...piece(colL.at, midY.at, colL.len, midY.len, colL.flip, false, 0, T, L, H - T - B),
    ...piece(colR.at, midY.at, colR.len, midY.len, colR.flip, false, W - R, T, R, H - T - B),
    ...piece(colL.at, rowB.at, colL.len, rowB.len, colL.flip, rowB.flip, 0, H - B, L, B),
    ...piece(midX.at, rowB.at, midX.len, rowB.len, false, rowB.flip, L, H - B, W - L - R, B),
    ...piece(colR.at, rowB.at, colR.len, rowB.len, colR.flip, rowB.flip, W - R, H - B, R, B),
    // sharp-yuv, because saturated line art through webp's usual chroma subsampling comes back with
    // cyan and magenta fringes on every black outline, and the bloom finds every one of them.
    '-quality', '92', '-define', 'webp:use-sharp-yuv=true',
    out,
  ]
  magick(args)
  return { opening, detected, mirrored, size: { w: W, h: H }, border: have }
}
