#!/usr/bin/env node
// Turn a per-frame trace of one fighter into numbers.
//
//   node tools/t3-probe/motion.mjs [measure.csv]
//
// Walk speed is a slope, a sidestep is a displacement and a duration, a jump is an apex and an
// airtime, and gravity is the second difference of height. All of it comes out of x, y and z
// sampled every frame with a label saying what the stick was doing.
import fs from 'node:fs'

const file = process.argv[2] ?? 'ext/reference-artwork/rom-dumps/t3/tekken3je1/measure.csv'
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => {
  const [frame, label, x, y, z, state, anim] = l.split(',')
  return { frame: +frame, label, x: +x, y: +y, z: +z, state: +state, anim: +anim }
})

const phases = []
for (const r of rows) {
  const p = phases[phases.length - 1]
  if (!p || p.label !== r.label) phases.push({ label: r.label, rows: [r] })
  else p.rows.push(r)
}

console.log('phase          frames        x            y            z         state')
for (const p of phases) {
  const a = p.rows[0], b = p.rows[p.rows.length - 1]
  const per = (k) => ((b[k] - a[k]) / p.rows.length).toFixed(2)
  console.log(
    `${p.label.padEnd(14)} ${String(p.rows.length).padStart(5)}  ` +
      `${String(a.x).padStart(6)}→${String(b.x).padStart(6)} (${per('x').padStart(6)}/f)  ` +
      `${String(a.y).padStart(4)}→${String(b.y).padStart(5)}  ` +
      `${String(a.z).padStart(5)}→${String(b.z).padStart(5)} (${per('z').padStart(6)}/f)  ${a.state}`,
  )
}

// --- the jump, in detail: it is the one move whose physics is a closed form
const air = rows.filter((r) => r.y !== 0)
if (air.length) {
  const first = air[0], last = air[air.length - 1]
  const apex = air.reduce((m, r) => (Math.abs(r.y) > Math.abs(m.y) ? r : m), air[0])
  console.log(`\n=== the jump ===`)
  console.log(`airborne frames : ${last.frame - first.frame + 1}`)
  console.log(`apex height     : ${apex.y} units, reached ${apex.frame - first.frame} frames in`)
  console.log(`launch velocity : ${air[1] ? air[1].y - air[0].y : '?'} units on the first frame`)
  const ys = air.map((r) => r.y)
  const dd = []
  for (let i = 2; i < ys.length; i++) dd.push(ys[i] - 2 * ys[i - 1] + ys[i - 2])
  const g = dd.filter((v) => v !== 0)
  if (g.length) {
    g.sort((a, b) => a - b)
    console.log(`gravity         : ${g[Math.floor(g.length / 2)]} units per frame per frame (median of the second difference)`)
  }
  console.log(`drift while airborne: x ${last.x - first.x}, z ${last.z - first.z}`)
}

// --- the sidestep: the thing a 2D board cannot do
const side = phases.filter((p) => p.label.startsWith('sidestep'))
if (side.length) {
  const rs = side.flatMap((p) => p.rows)
  const z0 = rs[0].z, zEnd = rs[rs.length - 1].z
  const moving = []
  for (let i = 1; i < rs.length; i++) if (rs[i].z !== rs[i - 1].z) moving.push(rs[i].frame)
  console.log(`\n=== the sidestep ===`)
  console.log(`z travelled     : ${zEnd - z0} units`)
  console.log(`frames moving   : ${moving.length ? moving[moving.length - 1] - moving[0] + 1 : 0}`)
  console.log(`x drift         : ${rs[rs.length - 1].x - rs[0].x} units`)
}
