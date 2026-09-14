#!/usr/bin/env node
// Which word is health.
//
//   node tools/t3-probe/hp.mjs [dump-dir]
//
// Six quiet samples say what "does nothing" means in this RAM — and it is the strictest filter
// available, because almost everything here is scratch that the renderer or the animation system
// rewrites every frame. Then: a sample just before contact, one after six punches, one sixty frames
// after that (health does not drift back), and one after six more. A word that was frozen through
// the quiet, fell twice, and held still in between is health, and very little else can be.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2] ?? 'ext/reference-artwork/rom-dumps/t3/tekken3je1'
const BASE = 0x200000
const rd = (n) => fs.readFileSync(path.join(dir, `hp-${n}.bin`))
const Q = ['q0', 'q1', 'q2', 'q3', 'q4', 'q5'].map(rd)
const [h0, h1, h1b, h2] = ['h0', 'h1', 'h1b', 'h2'].map(rd)
const N = h0.length

for (const width of [4, 2, 1]) {
  const read = (b, a) => (width === 4 ? b.readInt32LE(a) : width === 2 ? b.readInt16LE(a) : b.readUInt8(a))
  const hits = []
  let stable = 0
  for (let a = 0; a + width <= N; a += width) {
    const q0 = read(Q[0], a)
    if (!Q.every((b) => read(b, a) === q0)) continue
    stable++
    const v0 = read(h0, a), v1 = read(h1, a), v1b = read(h1b, a), v2 = read(h2, a)
    if (v1 !== v1b) continue                 // holds still between bouts
    if (!(v0 > v1 && v1 > v2)) continue      // falls, twice
    if (v0 <= 0 || v0 > 1024 || v2 < 0) continue
    hits.push({ a: BASE + a, q0, v0, v1, v2 })
  }
  console.log(`\n=== ${width * 8}-bit: ${stable} words were frozen through the quiet; ${hits.length} of them fell twice ===`)
  for (const h of hits.slice(0, 20)) {
    console.log(`  0x${h.a.toString(16)}  quiet ${String(h.q0).padStart(5)}   ${String(h.v0).padStart(5)} → ${String(h.v1).padStart(5)} → ${String(h.v2).padStart(5)}   lost ${h.v0 - h.v2}`)
  }
}
