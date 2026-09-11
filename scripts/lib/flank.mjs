// The shape of a cabinet's side, and getting artwork to actually be that shape.
//
// The side templates are drawn as the machine's outline, and a good generator will follow it — but
// it follows it the way a painter follows a reference, not the way a cutter follows a template. What
// comes back is *nearly* the shape: the notch a little shallower, the taper a little different, the
// whole thing a few percent wide. Laid on the cabinet, the few percent is the difference between
// artwork and a decal someone put on crooked — bare body showing along the bottom hem, and the art's
// own painted edge cutting across the middle of the panel where the real edge is not.
//
// So the drawn shape is conformed to the real one. The artwork carries its own outline (it is the
// only thing on the template's flat grey), so each row of it is measured, and each row is stretched
// to fill exactly the width the machine has at that height. A generator's near-miss becomes a hit,
// and it costs a few percent of horizontal squash in the rows where it was most wrong.

import { execFileSync } from 'node:child_process'

/**
 * The outline of a cabinet's side, as fractions of its bounding box, front of the machine at the
 * left and y running down the way an image does.
 *
 * Traced off a scan of a real upright: base, the swell of the control panel, the deck, the monitor
 * leaning back nineteen degrees, the speaker panel raked over it, the sign, and a top sloping away
 * to the back. The deep notch between the control panel and the sign is the whole shape of the
 * thing, and artwork that ignores it loses whatever it put up there.
 *
 * These are `FLANK_FIT` in apps/arcade/src/lobby/Cabinet.ts, which derives them from the machine
 * itself; apps/arcade/test/bezel.test.ts fails if the two drift apart.
 *
 * Front at the left is the *right* flank. The left one is the mirror image: its artwork reads the
 * same way round — both flanks are seen from opposite sides, so both want their text running left to
 * right — which puts the front of the machine, and the notch above it, at the other end.
 */
export const OUTLINE = [
  [0.15432099, 1],
  [0.15432099, 0.62348278],
  [0.1037037, 0.60366609],
  [0.03703704, 0.57394105],
  [0, 0.55412435],
  [0.24691358, 0.4956651],
  [0.42592593, 0.28758979],
  [0.11728395, 0.19246966],
  [0.11728395, 0.00743126],
  [0.13209877, 0],
  [0.3382716, 0],
  [1, 0.11196433],
  [1, 1],
]

/** What that outline's bounding box measures, wide over tall. */
export const ASPECT = 0.40128809

/** How wide the conformed panel is written. A flank is the biggest thing on a cabinet. */
const OUT_W = 640

/** A pixel this close to neutral, at this sort of brightness, is the template's field, not artwork. */
const isField = (r, g, b) => Math.abs(r - g) < 14 && Math.abs(g - b) < 14 && Math.abs(r - b) < 14 && r > 74 && r < 168

function readPixels(src, w, h) {
  const buf = execFileSync('magick', [src, '-resize', `${w}x${h}!`, '-depth', '8', 'ppm:-'], { maxBuffer: 1 << 30 })
  // P6 header: three whitespace-separated fields after the magic, then one whitespace byte.
  let at = 2
  const fields = []
  while (fields.length < 3) {
    while (at < buf.length && /\s/.test(String.fromCharCode(buf[at]))) at++
    if (String.fromCharCode(buf[at]) === '#') {
      while (String.fromCharCode(buf[at]) !== '\n') at++
      continue
    }
    let n = ''
    while (at < buf.length && !/\s/.test(String.fromCharCode(buf[at]))) n += String.fromCharCode(buf[at++])
    fields.push(Number(n))
  }
  return buf.subarray(at + 1)
}

/** Left and right edge of the outline at a height, in pixels, or null where it has none. */
function outlineSpan(outline, y, w, h) {
  const v = (y + 0.5) / h
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ux, uy] = outline[i]
    const [vx, vy] = outline[j]
    if (uy > v === vy > v) continue
    const x = ux + ((vx - ux) * (v - uy)) / (vy - uy)
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  if (hi < lo) return null
  return [lo * (w - 1), hi * (w - 1)]
}

/**
 * Conform one flank's artwork to the machine's outline and write it.
 *
 * Returns how much it had to move things: the mean and worst horizontal stretch, as a multiple, so a
 * generator that drew something else entirely is visible in the output rather than silently mangled.
 */
export function conformFlank(src, out, { mirror = false } = {}) {
  const w = OUT_W
  const h = Math.round(OUT_W / ASPECT)
  const px = readPixels(src, w, h)
  const outline = mirror ? OUTLINE.map(([x, y]) => [1 - x, y]) : OUTLINE

  const dst = Buffer.alloc(w * h * 3)
  let stretchSum = 0
  let stretchWorst = 1
  let rows = 0
  for (let y = 0; y < h; y++) {
    const row = y * w * 3
    // What the artwork drew on this row: its first and last pixel that is not the template's field.
    let sL = -1
    let sR = -1
    for (let x = 0; x < w; x++) {
      const i = row + x * 3
      if (isField(px[i], px[i + 1], px[i + 2])) continue
      if (sL < 0) sL = x
      sR = x
    }
    const span = outlineSpan(outline, y, w, h)
    if (!span || sL < 0 || sR - sL < 2) {
      // No artwork at this height, or no machine: leave the row as it arrived. Either way it is
      // outside the outline, so the geometry never shows it.
      px.copy(dst, row, row, row + w * 3)
      continue
    }
    const [oL, oR] = span
    const k = (sR - sL) / Math.max(1, oR - oL)
    stretchSum += k
    stretchWorst = Math.max(stretchWorst, k > 1 ? k : 1 / k)
    rows++
    for (let x = 0; x < w; x++) {
      const t = (x - oL) / Math.max(1, oR - oL)
      // Clamped, so the rows outside the outline carry the artwork's own edge colour rather than a
      // hard line the mipmaps would smear back across it.
      const sx = Math.max(sL, Math.min(sR, sL + t * (sR - sL)))
      const x0 = Math.floor(sx)
      const x1 = Math.min(sR, x0 + 1)
      const f = sx - x0
      const a = row + x0 * 3
      const b = row + x1 * 3
      const i = row + x * 3
      for (let c = 0; c < 3; c++) dst[i + c] = Math.round(px[a + c] * (1 - f) + px[b + c] * f)
    }
  }

  execFileSync('magick', ['-size', `${w}x${h}`, '-depth', '8', 'rgb:-', '-quality', '92', '-define', 'webp:use-sharp-yuv=true', out], { input: dst })
  return { size: { w, h }, stretch: rows ? stretchSum / rows : 1, worst: stretchWorst }
}
