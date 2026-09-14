#!/usr/bin/env node
// Which words in the fighter structure do something, and what.
//
//   node tools/t3-probe/columns.mjs [watch.csv]
//
// One row per sample, one column per word, and a label saying what the fighter was being told to do.
// A column that only moves while walking is a horizontal axis; one that only moves in the air is
// height; one that changes the instant a button is pressed and counts down is the move timer. This
// prints, for every column that is not constant, its value at the end of each phase — which is
// enough to read the structure off by eye.
import fs from 'node:fs'

const file = process.argv[2] ?? 'ext/reference-artwork/rom-dumps/t3/tekken3je1/watch.csv'
const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
const head = lines[0].split(',')
const rows = lines.slice(1).map((l) => l.split(','))

// One representative sample per phase: the last one, by which time the phase has taken effect.
const phases = []
for (const r of rows) {
  const label = r[1]
  if (!phases.length || phases[phases.length - 1].label !== label) phases.push({ label, row: r })
  else phases[phases.length - 1].row = r
}

const interesting = []
for (let c = 2; c < head.length; c++) {
  const vals = phases.map((p) => Number(p.row[c]))
  const uniq = new Set(vals)
  if (uniq.size < 2) continue
  const span = Math.max(...vals) - Math.min(...vals)
  interesting.push({ c, name: head[c], vals, span })
}

console.log(`phases: ${phases.map((p) => p.label).join(' → ')}\n`)
console.log(`${interesting.length} of ${head.length - 2} words change\n`)
const w = 9
console.log(['word'.padEnd(12), ...phases.map((p) => p.label.slice(0, w).padStart(w))].join(' '))
for (const col of interesting.sort((a, b) => a.c - b.c)) {
  console.log([col.name.padEnd(12), ...col.vals.map((v) => String(v).padStart(w))].join(' '))
}
