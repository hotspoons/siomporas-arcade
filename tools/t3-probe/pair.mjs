#!/usr/bin/env node
// The stride between the two fighters, and therefore the shape of one.
//
//   node tools/t3-probe/pair.mjs [dump-dir]
//
// Five samples: at rest, after player one walks, a settled baseline, after player two walks, and a
// second baseline. A word that moved for the first walk and sat still through the second is player
// one's; the mirror is player two's. Those two sets are the same structure at two addresses, so the
// offset that appears between them again and again is the stride — and the stride is the discovery,
// because it turns every future find on one fighter into the same field on the other.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] ?? 'ext/reference-artwork/rom-dumps/t3/tekken3je1'
const BASE = 0x200000
const S = ['a0', 'a1', 'a2', 'a3', 'a4'].map((n) => fs.readFileSync(path.join(dir, `pair-${n}.bin`)))
// The quiet pair: nothing happened between these two, so anything that differs is the renderer
// refilling its own buffers and can never be a fighter's position.
const Q = ['q0', 'q1', 'q2'].map((n) => fs.readFileSync(path.join(dir, `pair-${n}.bin`)))
const N = S[0].length

const p1 = [], p2 = []
let masked = 0
for (let a = 0; a + 4 <= N; a += 4) {
  const q = Q.map((b) => b.readInt32LE(a))
  if (q[0] !== q[1] || q[1] !== q[2]) { masked++; continue }
  // A world coordinate on this board is a small fixed-point number. Colour and vertex data is not:
  // 0x808080 is grey, not a position, and the live half of RAM is full of it.
  if (Math.abs(q[0]) > (1 << 20)) continue
  const v = S.map((b) => b.readInt32LE(a))
  const movedByP1 = v[1] !== v[0]
  const stillAfter = v[2] === v[1] && v[3] === v[2] && v[4] === v[3]
  const stillBefore = v[1] === v[0] && v[2] === v[1]
  const movedByP2 = v[3] !== v[2] && v[4] === v[3]
  // A coordinate settles: it is not still *because* nothing writes it, it is still because the
  // fighter stopped. Requiring a plausible magnitude drops the counters and the junk.
  const delta = Math.abs(v[1] - v[0])
  if (movedByP1 && stillAfter && delta > 4 && delta < 1 << 24) p1.push({ a, v })
  const delta2 = Math.abs(v[3] - v[2])
  if (stillBefore && movedByP2 && delta2 > 4 && delta2 < 1 << 24) p2.push({ a, v })
}
console.log(`words masked out as renderer churn: ${masked}`)
console.log(`player one's words: ${p1.length}`)
console.log(`player two's words: ${p2.length}`)

// The stride: how far apart the same field sits on the two fighters.
const set2 = new Map(p2.map((h) => [h.a, h]))
const tally = new Map()
for (const h of p1) {
  for (const d of set2.keys()) {
    const gap = d - h.a
    if (gap === 0) continue
    if (Math.abs(gap) > 0x20000) continue
    tally.set(gap, (tally.get(gap) ?? 0) + 1)
  }
}
const best = [...tally.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)
console.log("\n=== every word that moved for player one and then held still ===")
for (const h of p1) {
  console.log(`  0x${(BASE + h.a).toString(16)}  ${h.v.map((x) => String(x).padStart(8)).join(' ')}`)
}

console.log('\nmost common offsets from a player-one word to a player-two word:')
for (const [gap, n] of best) console.log(`  ${gap >= 0 ? '+' : '-'}0x${Math.abs(gap).toString(16).padStart(5, '0')}   ${n} pairs`)

const stride = best[0]?.[0]
if (stride) {
  console.log(`\n=== fields that exist on both fighters at a stride of ${stride >= 0 ? '+' : '-'}0x${Math.abs(stride).toString(16)} ===`)
  let shown = 0
  for (const h of p1) {
    const other = set2.get(h.a + stride)
    if (!other) continue
    if (shown++ > 24) break
    console.log(
      `  p1 0x${(BASE + h.a).toString(16)}  ${h.v.map((x) => String(x).padStart(8)).join(' ')}\n` +
        `  p2 0x${(BASE + other.a).toString(16)}  ${other.v.map((x) => String(x).padStart(8)).join(' ')}\n`,
    )
  }
}
