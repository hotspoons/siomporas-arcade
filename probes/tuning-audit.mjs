#!/usr/bin/env node
// Which knobs in tuning.ts have no slider? Section 7 task 4: every `export let` gets a `tune()`
// entry, or Rich cannot reach it and it is a number only an agent can change.
//   node probes/tuning-audit.mjs [--json]
import { readFileSync } from 'node:fs'

const src = readFileSync('apps/corridor/src/tuning.ts', 'utf8')
const declared = [...src.matchAll(/^export let (\w+)/gm)].map((m) => m[1])
const tuned = new Set([...src.matchAll(/tune\('(\w+)'/g)].map((m) => m[1]))
// which tab each declaration falls under, by the last `// --- name ---` banner above it
const banners = [...src.matchAll(/^\/\/ --- (.+?) -+$/gm)].map((m) => ({ at: m.index, name: m[1].trim() }))
const groupOf = (name) => {
  const at = src.indexOf(`export let ${name}`)
  let g = '(none)'
  for (const b of banners) if (b.at < at) g = b.name
  return g
}
const missing = declared.filter((d) => !tuned.has(d))
const orphan = [...tuned].filter((t) => !declared.includes(t))
const by = {}
for (const m of missing) (by[groupOf(m)] ??= []).push(m)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ declared: declared.length, tuned: tuned.size, missing, orphan }, null, 1))
} else {
  console.log(`${declared.length} knobs declared, ${tuned.size} with a slider, ${missing.length} without\n`)
  for (const [g, list] of Object.entries(by)) console.log(`  ${g}\n    ${list.join('\n    ')}`)
  if (orphan.length) console.log(`\n  tune() entries with no export let (stale): ${orphan.join(', ')}`)
}
