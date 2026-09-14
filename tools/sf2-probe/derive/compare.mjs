#!/usr/bin/env node
// What one edition changed about another, for a character measured on both.
//
//   node tools/sf2-probe/derive/compare.mjs ce.raw.json "Champion Edition" st.raw.json "Super Turbo" out.md
//
// editions.mjs does this for the three arcade Street Fighter IIs and knows their names. This one
// takes any two measurements of the same character and writes the differences: a move whose numbers
// match in both is not interesting and is left out, so what remains is what the designers actually
// touched between one board and the next.

import fs from 'node:fs'

const [aPath, aName, bPath, bName, out] = process.argv.slice(2)
if (!out) {
  console.error('usage: compare.mjs <a.raw.json> "<A>" <b.raw.json> "<B>" <out.md>')
  process.exit(1)
}
const A = JSON.parse(fs.readFileSync(aPath, 'utf8'))
const B = JSON.parse(fs.readFileSync(bPath, 'utf8'))

const frames = (m) => (m ? `${m.startup}/${m.active}/${m.recovery}` : '—')
const contact = (m) => m?.hit ?? m?.fhit ?? m?.chit
const damage = (m) => {
  const h = contact(m)
  if (!h?.damage) return '—'
  return h.damage.min === h.damage.max ? `${h.damage.min}` : `${h.damage.min}–${h.damage.max}`
}
const stuck = (m) => contact(m)?.stuckFrames ?? '—'
const same = (x, y) => String(x) === String(y)

const lines = []
lines.push(`# ${A.id[0].toUpperCase()}${A.id.slice(1)}: ${aName} against ${bName}`, '')
lines.push(
  `Both measured by \`tools/sf2-probe\` with the same plan — \`${A.romset}\` and \`${B.romset}\` — so the`,
  'numbers are comparable frame for frame. Rows where nothing changed are left out.',
  '',
)

// --- how the character moves
const moveRows = [
  ['walk forward / back, px per frame', (d) => `${d.calib.walkFwd} / ${d.calib.walkBack}`],
  ['jump: launch speed / gravity', (d) => `${d.calib.jumpNeutral?.vy0} / ${d.calib.jumpNeutral?.gravity}`],
  ['jump: airborne frames / apex', (d) => `${d.calib.jumpNeutral?.airborne ?? '—'} / ${d.calib.jumpNeutral?.apex ?? '—'}`],
  ['forward jump distance, px', (d) => d.calib.jumpForward?.dx ?? '—'],
  ['landing recovery', (d) => d.calib.landingRecovery ?? '—'],
  ['round timer, frames per tick', (d) => d.calib.timerFramesPerTick ?? '—'],
  ['throw damage', (d) => d.throws?.['throw-fwd-hp']?.damage?.mean ?? '—'],
]
lines.push('## The character itself', '', `| | ${aName} | ${bName} |`, '|---|---|---|')
for (const [label, f] of moveRows) {
  let x, y
  try { x = f(A) } catch { x = '—' }
  try { y = f(B) } catch { y = '—' }
  lines.push(`| ${label} | ${x} | ${y} |`)
}
lines.push('')

// --- the moves, only where something moved
function table(title, ids, get) {
  const rows = []
  for (const id of ids) {
    const a = get(A, id)
    const b = get(B, id)
    if (!a && !b) continue
    const fa = frames(a), fb = frames(b)
    const da = damage(a), db = damage(b)
    const sa = stuck(a), sb = stuck(b)
    if (same(fa, fb) && same(da, db) && same(sa, sb)) continue
    rows.push(`| ${id} | ${fa} | ${fb} | ${da} | ${db} | ${sa} | ${sb} |`)
  }
  if (!rows.length) return
  lines.push(`## ${title}`, '')
  lines.push('start/active/recovery, then damage, then how many frames the victim is stuck.', '')
  lines.push(`| move | ${aName} | ${bName} | dmg ${aName} | dmg ${bName} | stuck ${aName} | stuck ${bName} |`)
  lines.push('|---|---|---|---|---|---|---|')
  lines.push(...rows, '')
}

const ids = (key) => [...new Set([...Object.keys(A[key] ?? {}), ...Object.keys(B[key] ?? {})])]
table('Normals', ids('normals').sort(), (d, id) => d.normals?.[id])
table('Specials', ids('specials').sort(), (d, id) => d.specials?.[id])

// --- what only one of them has
const onlyIn = (x, y, key) => ids(key).filter((id) => x[key]?.[id] && !y[key]?.[id])
for (const [label, list] of [
  [`only in ${aName}`, [...onlyIn(A, B, 'normals'), ...onlyIn(A, B, 'specials')]],
  [`only in ${bName}`, [...onlyIn(B, A, 'normals'), ...onlyIn(B, A, 'specials')]],
]) {
  if (list.length) lines.push(`**${label}:** ${list.join(', ')}`, '')
}

fs.writeFileSync(out, lines.join('\n'))
console.log(`${out}: ${lines.length} lines`)
