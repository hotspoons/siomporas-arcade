#!/usr/bin/env node
// Which words name what the fighter is doing.
//
//   node tools/t3-probe/state.mjs [dump-dir]
//
// One value while standing, another throughout a kick, back to the first afterwards — and small,
// because a phase is an enumeration and not a coordinate. On Virtua Fighter 2 exactly one word fit
// that description and it turned nine moves into frame data in a single run.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] ?? 'ext/reference-artwork/rom-dumps/t3/tekken3je1'
const BASE = 0x200000
const rd = (n) => fs.readFileSync(path.join(dir, `st-${n}.bin`))
const Q = ['q0', 'q1', 'q2', 'q3'].map(rd)
const D = ['d0', 'd1', 'd2', 'd3'].map(rd)
const after = rd('after')
const N = Q[0].length

const hits = []
for (let a = 0; a + 4 <= N; a += 4) {
  const q = Q[0].readInt32LE(a)
  if (q < 0 || q > 8) continue                       // a phase is a small enumeration
  if (!Q.every((b) => b.readInt32LE(a) === q)) continue
  if (after.readInt32LE(a) !== q) continue
  const d = D.map((b) => b.readInt32LE(a))
  if (d.some((v) => v === q)) continue                // different for the whole move
  if (d.some((v) => v < 0 || v > 8)) continue
  hits.push({ a: BASE + a, q, d })
}
console.log(`${hits.length} words are one small value at rest, another throughout a kick, and back\n`)
for (const h of hits.slice(0, 30)) {
  console.log(`  0x${h.a.toString(16)}  rest ${h.q}   during ${h.d.join(' ')}`)
}
