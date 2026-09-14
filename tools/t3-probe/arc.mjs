#!/usr/bin/env node
// Find the column that makes an arc while the fighter is in the air.
//
//   node tools/t3-probe/arc.mjs [watch.csv] [phase=jump,airborne]
//
// The samples are three frames apart, so a jump is a dozen of them. Height is the column that is
// flat before the jump, leaves that value, rises to a single peak, comes back down, and finishes on
// the value it started from. Printed with its whole trace, because an arc is something you should
// look at rather than take a filter's word for.
import fs from 'node:fs'

const file = process.argv[2] ?? 'ext/reference-artwork/rom-dumps/t3/tekken3je1/watch.csv'
const want = (process.argv[3] ?? 'jump,airborne').split(',')
const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
const head = lines[0].split(',')
const rows = lines.slice(1).map((l) => l.split(','))

const before = rows.filter((r) => r[1] === 'idle3' || r[1] === 'sidestep2')
const during = rows.filter((r) => want.includes(r[1]))
if (!during.length) { console.error('no rows for', want, '— labels:', [...new Set(rows.map((r) => r[1]))].join(' ')); process.exit(1) }

const hits = []
for (let c = 2; c < head.length; c++) {
  const pre = before.map((r) => Number(r[c]))
  const air = during.map((r) => Number(r[c]))
  if (!pre.length) continue
  const rest = pre[pre.length - 1]
  if (air.every((v) => v === rest)) continue
  const away = air.map((v) => Math.abs(v - rest))
  const peak = away.indexOf(Math.max(...away))
  if (peak === 0 || peak === away.length - 1) continue
  if (Math.max(...away) < 8) continue
  const rising = away.slice(0, peak + 1).every((v, i, a) => i === 0 || v >= a[i - 1])
  const falling = away.slice(peak).every((v, i, a) => i === 0 || v <= a[i - 1])
  if (!rising || !falling) continue
  hits.push({ name: head[c], rest, air, peak: Math.max(...away) })
}
console.log(`${hits.length} columns arc during ${want.join('+')}\n`)
for (const h of hits.sort((a, b) => b.peak - a.peak)) {
  console.log(`${h.name}  rest ${h.rest}\n   ${h.air.join(' ')}\n`)
}
