#!/usr/bin/env node
// Compact tables for a shaped character JSON, and the differences from the seeded config.
//   node report.mjs <shaped.json> [seed.json]
import fs from 'node:fs'
const [p, seedPath] = process.argv.slice(2)
const d = JSON.parse(fs.readFileSync(p, 'utf8'))
const seed = seedPath && fs.existsSync(seedPath) ? JSON.parse(fs.readFileSync(seedPath, 'utf8')) : null
const f = (m) => `${m.startup}/${m.active}/${m.recovery}`
console.log(`## ${d.name}: walk ${d.walkFwd}/${d.walkBack} px/f, jump vy0 ${d.jump.vy} g ${d.jump.gravity} vx ${d.jump.vx} prejump ${d.jump.prejump} air ${d.jump.airborne}f apex ${d.jump.apex}px fwd ${d.jump.forwardDx}px; push half ${d.bodyHalf}; throw dmg ${d.throw?.damage} reach ${d.throw?.range} (own box ${d.throw?.reachOwn}) lands on f${d.throw?.damageFrame}`)
console.log('| move | s/a/r | dmg | dizzy | hitstun/blockstun | push | box | height |', '\n|---|---|---|---|---|---|---|---|')
for (const [id, m] of Object.entries(d.normals)) console.log(`| ${id} | ${f(m)} | ${m.damage ?? '-'}${m.hits > 1 ? ` (${m.hits} hits)` : ''} | ${m.stun ?? '-'} | ${m.hitstun ?? '-'}/${m.blockstun ?? '-'} | ${m.pushHit ?? '-'} | [${m.hitbox}] | ${m.height}${m.knockdown ? ' KD' : ''} |`)
for (const s of d.specials) {
  console.log(`| **${s.id}** (${s.type}) | | | | | | | |`)
  for (const [k, v] of Object.entries(s.strengths)) console.log(`| ${s.id}-${k} | ${f(v)} | ${v.damage ?? '-'} | ${v.stun ?? '-'} | ${v.hitstun ?? '-'}/${v.blockstun ?? '-'} chip ${v.chip} | ${v.pushHit ?? '-'} | [${v.hitbox}]${v.projectile ? ` fireball ${v.projectile.speed}px/f` : ''} | ${v.knockdown ? 'KD' : ''} ${v.travel?.dx ? `dx ${v.travel.dx}` : ''} |`)
}
if (seed) {
  console.log('\nSeed vs ROM (startup/active/recovery, damage):')
  for (const [id, sm] of Object.entries(seed.normals)) {
    const m = d.normals[id]
    if (!m) { console.log(`  ${id}: not in ROM data`); continue }
    if (sm.startup !== m.startup || sm.active !== m.active || sm.recovery !== m.recovery || sm.damage !== m.damage) console.log(`  ${id}: seed ${sm.startup}/${sm.active}/${sm.recovery} dmg ${sm.damage} -> ROM ${f(m)} dmg ${m.damage}`)
  }
  console.log(`  walk: seed ${seed.walkFwd}/${seed.walkBack} -> ROM ${d.walkFwd}/${d.walkBack}; jump vy ${seed.jump.vy} g ${seed.jump.gravity} vx ${seed.jump.vx} -> ROM ${d.jump.vy} g ${d.jump.gravity} vx ${d.jump.vx}; throw ${seed.throw.damage}@${seed.throw.range} -> ${d.throw?.damage}@${d.throw?.range}; hurt stand ${JSON.stringify(seed.hurt.stand)} -> ${JSON.stringify(d.hurt.stand)}`)
}
