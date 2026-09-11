// The shape of a cabinet's side, and getting artwork to sit on it without a hem showing.
//
// The side templates are drawn as the machine's outline, and a good generator will follow it — but
// it follows it the way a painter follows a reference, not the way a cutter follows a template. What
// comes back is *nearly* the shape: the notch a little shallower, the taper a little different, the
// whole thing a few percent wide. The geometry cuts the real outline out of whatever texture it is
// given, so wherever the machine reaches past the drawn shape you get the template's flat grey
// showing — a pale hem along the bottom of the cabinet and up one edge.
//
// So the grey is got rid of. Each row of artwork is measured and its own edge colour is carried out
// to the ends of the row, which covers the few percent the generator was out by, in the artwork's
// own colours, and is then cut away by the geometry anyway wherever the machine does not reach.
//
// What this deliberately does *not* do is stretch each row to fit the outline. That was the first
// attempt and it is a trap: the measured edge of a drawn shape jitters by a pixel or two from row to
// row, every one of those becomes a different horizontal scale, and the artwork comes out visibly
// melted sideways. The drawn shape is close enough to the real one that nothing needs bending.

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

/** How wide the dressed panel is written. A flank is the biggest thing on a cabinet. */
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
 * Fill the template's field around one flank's artwork with the artwork's own edges, and write it.
 *
 * The artwork's bounding box is stretched to the panel's, which squares up the few percent the
 * generator drew it out by — uniformly, over the whole panel, which no eye picks up. Returns how
 * much of the machine the drawn shape actually covered before anything was carried out, so a
 * generator that drew something else entirely shows up as a number rather than as a mess.
 */
export function fillFlank(src, out, { mirror = false } = {}) {
  const w = OUT_W
  const h = Math.round(OUT_W / ASPECT)
  const px = readPixels(src, w, h)
  const outline = mirror ? OUTLINE.map(([x, y]) => [1 - x, y]) : OUTLINE

  // Where the artwork starts and ends on each row. Measured first, then smoothed: a drawn edge is
  // ragged by a pixel or two and the carried-out colour should not be.
  const left = new Int32Array(h).fill(-1)
  const right = new Int32Array(h).fill(-1)
  for (let y = 0; y < h; y++) {
    const row = y * w * 3
    for (let x = 0; x < w; x++) {
      const i = row + x * 3
      if (isField(px[i], px[i + 1], px[i + 2])) continue
      if (left[y] < 0) left[y] = x
      right[y] = x
    }
  }
  const median = (list) => list.slice().sort((a, b) => a - b)[list.length >> 1]
  const smooth = (edge) => {
    const out = Int32Array.from(edge)
    for (let y = 0; y < h; y++) {
      const near = []
      for (let d = -3; d <= 3; d++) {
        const v = edge[y + d]
        if (y + d >= 0 && y + d < h && v >= 0) near.push(v)
      }
      if (near.length) out[y] = median(near)
    }
    return out
  }
  const sL = smooth(left)
  const sR = smooth(right)

  const dst = Buffer.alloc(w * h * 3)
  let covered = 0
  let machine = 0
  for (let y = 0; y < h; y++) {
    const row = y * w * 3
    // A row with no artwork on it at all borrows the nearest row that has some, so the very top and
    // bottom of a panel are never a grey band.
    let from = y
    if (left[from] < 0) {
      for (let d = 1; d < h; d++) {
        if (y - d >= 0 && left[y - d] >= 0) {
          from = y - d
          break
        }
        if (y + d < h && left[y + d] >= 0) {
          from = y + d
          break
        }
      }
    }
    const a = Math.max(0, sL[from])
    const b = Math.max(a, sR[from])
    const src0 = from * w * 3
    const span = outlineSpan(outline, y, w, h)
    for (let x = 0; x < w; x++) {
      const take = src0 + Math.min(b, Math.max(a, x)) * 3
      const i = row + x * 3
      dst[i] = px[take]
      dst[i + 1] = px[take + 1]
      dst[i + 2] = px[take + 2]
      if (!span || x < span[0] || x > span[1]) continue
      machine++
      if (x >= a && x <= b) covered++
    }
  }

  execFileSync('magick', ['-size', `${w}x${h}`, '-depth', '8', 'rgb:-', '-quality', '92', '-define', 'webp:use-sharp-yuv=true', out], { input: dst })
  return { size: { w, h }, covered: machine ? covered / machine : 1 }
}
