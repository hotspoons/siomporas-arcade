#!/usr/bin/env node
// Which words in RAM are the fighter's position.
//
//   node tools/t3-probe/walk.mjs [dump-dir]
//
// Eight samples: at rest, four along a backwards walk into open floor, one after she has stopped,
// and two after sidesteps. Two tests, and a word has to pass one of them cleanly:
//
//   x — rises or falls by about the same amount between each walking sample, then **stops** when
//       she stops. The stop is what kills the display lists: they keep churning.
//   z — flat through the entire walk, then moves on the sidestep. Nothing that is merely busy is
//       flat for 140 frames and then moves exactly when the stick is tapped.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] ?? 'ext/reference-artwork/rom-dumps/t3/tekken3je1'
const BASE = 0x200000
const NAMES = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 's1', 's2']
const S = NAMES.map((n) => fs.readFileSync(path.join(dir, `walk-${n}.bin`)))
const N = S[0].length
const hex = (a) => `0x${a.toString(16)}`

for (const width of [4, 2]) {
  const read = (b, a) => (width === 4 ? b.readInt32LE(a) : b.readInt16LE(a))
  const xs = [], zs = []
  for (let a = 0; a + width <= N; a += width) {
    const v = S.map((b) => read(b, a))
    const walk = [v[1] - v[0], v[2] - v[1], v[3] - v[2], v[4] - v[3]]
    const stopped = v[5] - v[4]
    const step1 = v[6] - v[5]
    const step2 = v[7] - v[6]

    // --- x: even movement while walking, and a real stop afterwards
    const mag = walk.map(Math.abs)
    const even = Math.min(...mag) > 0 && Math.max(...mag) <= Math.min(...mag) * 1.8
    const sameWay = walk.every((d) => Math.sign(d) === Math.sign(walk[0]))
    if (even && sameWay && Math.abs(stopped) <= Math.min(...mag) * 0.25) {
      xs.push({ a: BASE + a, v, per: Math.round((v[4] - v[0]) / 4) })
    }
    // --- z: nothing at all during the walk, then movement on each sidestep, both the same way
    const still = v.slice(0, 6).every((x) => x === v[0])
    if (still && step1 !== 0 && step2 !== 0 && Math.sign(step1) === Math.sign(step2)) {
      zs.push({ a: BASE + a, v, step1, step2 })
    }
  }
  console.log(`\n=== ${width * 8}-bit ===`)
  console.log(`x-like (walks evenly, then stops): ${xs.length}`)
  for (const h of xs.slice(0, 20)) console.log(`  ${hex(h.a)}  ${h.v.map((x) => String(x).padStart(8)).join(' ')}  per-30f ${h.per}`)
  console.log(`z-like (still through the walk, moves on each sidestep): ${zs.length}`)
  for (const h of zs.slice(0, 20)) console.log(`  ${hex(h.a)}  ${h.v.map((x) => String(x).padStart(8)).join(' ')}  steps ${h.step1} ${h.step2}`)
}
