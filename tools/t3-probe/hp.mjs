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
// q1..q5 only: the probe's first quiet sample lands on the same frame as a state transition and is
// sometimes not written, and a stale q0 left over from a previous run would poison every comparison
// silently. Five quiet samples is plenty.
const Q = ['q1', 'q2', 'q3', 'q4', 'q5'].map(rd)
const [h0, h1, h1b, h2] = ['h0', 'h1', 'h1b', 'h2'].map(rd)
const N = h0.length

// Two lessons from doing this on Model 2, both of which this file originally got wrong.
//
// **Scan 16-bit halves.** On Virtua Fighter 2 health sits beside a per-frame counter, so no 32-bit
// word containing it ever looks still and a word-aligned pass cannot find it at any threshold.
//
// **Do not demand that it fall twice.** It sounds like the stricter test and it is simply wrong: if
// the second bout of punches misses, the true answer fell once and then held, and the filter throws
// it away. Falling and never recovering is the property health actually has.
for (const width of [4, 2, 1]) {
  const read = (b, a) => (width === 4 ? b.readInt32LE(a) : width === 2 ? b.readInt16LE(a) : b.readUInt8(a))
  const step = width === 4 ? 4 : width === 2 ? 2 : 1
  const hits = []
  let stable = 0
  for (let a = 0; a + width <= N; a += step) {
    const q0 = read(Q[0], a)
    if (!Q.every((b) => read(b, a) === q0)) continue
    stable++
    const v0 = read(h0, a), v1 = read(h1, a), v1b = read(h1b, a), v2 = read(h2, a)
    if (v1 !== v1b) continue                 // holds still between bouts
    if (!(v0 > v1 && v1 >= v2)) continue     // falls, and never recovers
    if (v0 <= 8 || v0 > 1024 || v2 < 0) continue
    // Nothing had happened yet when h0 was taken, so health must still read exactly what it read
    // through the quiet. A word that was zero during the quiet and something else by h0 is busy,
    // not still, and it was only the sampling gap that let it look otherwise.
    if (v0 !== q0) continue
    if (q0 < 40) continue
    hits.push({ a: BASE + a, off: a, q0, v0, v1, v2 })
  }

  // The filter nothing else has: **the two fighters are the same structure 0x1ae4 apart**. Player
  // one threw every punch and took none, so his health sat perfectly still at full — and it sits at
  // exactly this offset minus the stride. A falling number with an unchanging twin one struct away,
  // both starting from the same value, is health and almost nothing else can be.
  const STRIDE = 0x1ae4
  const paired = hits.filter((h) => {
    const twin = h.off - STRIDE
    if (twin < 0) return false
    const t0 = read(Q[0], twin)
    if (t0 !== h.q0) return false                       // both fighters start with the same health
    if (!Q.every((b) => read(b, twin) === t0)) return false
    return read(h0, twin) === t0 && read(h1, twin) === t0 && read(h2, twin) === t0
  })
  if (paired.length) {
    console.log(`\n  --- ${paired.length} of them have a motionless twin one struct (0x${STRIDE.toString(16)}) below ---`)
    for (const h of paired.slice(0, 60)) {
      console.log(`    P2 0x${h.a.toString(16)}  ${h.q0} → ${h.v1} → ${h.v2}     P1 0x${(h.a - STRIDE).toString(16)}  ${h.q0} throughout`)
    }
  }
  console.log(`\n=== ${width * 8}-bit: ${stable} were frozen through the quiet; ${hits.length} then fell and stayed down ===`)
  for (const h of hits.slice(0, 20)) {
    console.log(`  0x${h.a.toString(16)}  quiet ${String(h.q0).padStart(5)}   ${String(h.v0).padStart(5)} → ${String(h.v1).padStart(5)} → ${String(h.v2).padStart(5)}   lost ${h.v0 - h.v2}`)
  }
}
