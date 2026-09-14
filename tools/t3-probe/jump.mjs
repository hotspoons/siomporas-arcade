#!/usr/bin/env node
// Which word is height.
//
//   node tools/t3-probe/jump.mjs [dump-dir]
//
// Three quiet samples mask the renderer. Then: standing, three samples in the air, standing again.
// Height is the word that is identical before and after, different in all three airborne samples,
// and traces an arc — up, up-or-over, down. Very little else in four megabytes does that.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] ?? 'ext/reference-artwork/rom-dumps/t3/tekken3je1'
const BASE = 0x200000
const rd = (n) => fs.readFileSync(path.join(dir, `jump-${n}.bin`))
const AIR = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map(rd)
const [g0, g1] = ['g0', 'g1'].map(rd)
const N = g0.length

const hits = []
for (const width of [4, 2]) {
 const read = (b, a) => (width === 4 ? b.readInt32LE(a) : b.readInt16LE(a))
 for (let a = 0; a + width <= N; a += width) {
  const G0 = read(g0, a), G1 = read(g1, a)
  if (G0 !== G1) continue                       // back to exactly where it started
  const air = AIR.map((b) => read(b, a))
  if (air.some((v) => v === G0)) continue       // genuinely off the ground the whole way
  if (Math.abs(G0) > (1 << 20) || air.some((v) => Math.abs(v) > (1 << 20))) continue
  const s = Math.sign(air[0] - G0)
  if (!air.every((v) => Math.sign(v - G0) === s)) continue
  // An arc, not a step: it has to rise to a peak and come back down, and the peak must not be at
  // either end, or it is a value that simply changed and changed back.
  const away = air.map((v) => Math.abs(v - G0))
  const peak = away.indexOf(Math.max(...away))
  if (peak === 0 || peak === away.length - 1) continue
  const rising = away.slice(0, peak + 1).every((v, i, arr) => i === 0 || v >= arr[i - 1])
  const falling = away.slice(peak).every((v, i, arr) => i === 0 || v <= arr[i - 1])
  if (!rising || !falling) continue
  hits.push({ a: BASE + a, width, G0, air, G1 })
 }
}
console.log(`\n=== ${hits.length} words left the ground and came back ===`)
for (const h of hits) {
  console.log(
    `  0x${h.a.toString(16)} (${h.width * 8}b)  ground ${String(h.G0).padStart(7)}   air ${h.air.map((v) => String(v).padStart(7)).join(' ')}   back ${String(h.G1).padStart(7)}`,
  )
}
