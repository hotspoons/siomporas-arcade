#!/usr/bin/env node
// Diff Ryu between editions: node editions.mjs <ce.raw.json> <ww.raw.json> <hf.raw.json> <out.md>
import fs from 'node:fs'
const [ce, ww, hf, out] = process.argv.slice(2)
const L = { ce: JSON.parse(fs.readFileSync(ce)), ww: JSON.parse(fs.readFileSync(ww)), hf: JSON.parse(fs.readFileSync(hf)) }
const fr = (m) => (m ? `${m.startup}/${m.active}/${m.recovery} (${m.total})` : '-')
const dmg = (m) => { const h = m?.hit ?? m?.fhit; return h?.damage ? `${h.damage.min}-${h.damage.max}` : '-' }
const stk = (m) => { const h = m?.hit ?? m?.fhit; return h?.stuckFrames ?? '-' }
const lines = []
lines.push('# Ryu across the three arcade editions', '', 'Measured with the same plan on `sf2` (World Warrior, WW), `sf2ceea` (Champion Edition, CE) and `sf2hfu` (Hyper Fighting, HF). HF runs its game logic faster than the display (turbo), so its frame counts are display frames and read about 0.7× CE.', '')
lines.push('| | WW | CE | HF |', '|---|---|---|---|')
for (const [k, f] of [['walk fwd/back px/f', (d) => `${d.calib.walkFwd} / ${d.calib.walkBack}`], ['jump vy0 / gravity / fwd vx', (d) => `${d.calib.jumpNeutral.vy0} / ${d.calib.jumpNeutral.gravity} / ${d.calib.jumpForward.vx0}`], ['timer frames per tick', (d) => d.calib.timerFramesPerTick], ['throw damage', (d) => d.throws['throw-fwd-hp']?.damage?.mean ?? '-'], ['dizzy: pokes 22/25/27/28/29 + jab → dizzy?', (d) => (d.dizzy.thresholdProbe ?? []).map((t) => `${t.preloaded}:${t.results.map((r) => (r.dizzy ? 'Y' : 'n')).join('')}`).join(' ')]]) {
  lines.push(`| ${k} | ${f(L.ww)} | ${f(L.ce)} | ${f(L.hf)} |`)
}
lines.push('', '## Normals: startup/active/recovery (total) · damage · frames the victim is stuck', '', '| move | WW | CE | HF |', '|---|---|---|---|')
for (const id of Object.keys(L.ce.normals)) lines.push(`| ${id} | ${fr(L.ww.normals[id])} · ${dmg(L.ww.normals[id])} · ${stk(L.ww.normals[id])} | ${fr(L.ce.normals[id])} · ${dmg(L.ce.normals[id])} · ${stk(L.ce.normals[id])} | ${fr(L.hf.normals[id])} · ${dmg(L.hf.normals[id])} · ${stk(L.hf.normals[id])} |`)
lines.push('', '## Specials', '', '| move | WW | CE | HF |', '|---|---|---|---|')
for (const id of Object.keys(L.ce.specials)) {
  const p = (d) => (d.specials[id]?.projectile ? ` · fireball ${d.specials[id].projectile.speed} px/f` : '')
  const kd = (d) => (d.specials[id]?.hit?.knockdown ? ' · KD' : '')
  lines.push(`| ${id} | ${fr(L.ww.specials[id])} · ${dmg(L.ww.specials[id])}${p(L.ww)}${kd(L.ww)} | ${fr(L.ce.specials[id])} · ${dmg(L.ce.specials[id])}${p(L.ce)}${kd(L.ce)} | ${fr(L.hf.specials[id])} · ${dmg(L.hf.specials[id])}${p(L.hf)}${kd(L.hf)} |`)
}
lines.push('', '## What changed', '',
  '* WW damage is much higher across the board (jab 14 vs 4–5, fierce 28–29 vs 19, shoryuken 38 vs 26–29, hadouken 19–22 vs 9–12, throw 38 vs 32); CE halved most of it. HF keeps CE damage.',
  '* WW\'s round timer ticks every 30 frames (99 counts ≈ 50 s), CE\'s every 40 (≈ 66 s).',
  '* WW\'s dizzy threshold is lower and looser (pokes of 22–25 already dizzy about half the time); CE and HF dizzy exactly when the meter would pass 30.',
  '* The hitboxes and the startup/active/recovery of Ryu\'s normals are identical between WW and CE; HF\'s are the same animations played at turbo speed.',
  '* Hadouken: CE fireballs travel 3/4/5 px per frame for LP/MP/HP, HF 4.5/5.5/6.9 (turbo); WW\'s startup is 13 frames vs CE\'s 9.',
  '* The hurricane kick knocks down in CE and HF; the WW one hit the dummy repeatedly without knocking down (44–64 damage over the spin).',
  '')
fs.writeFileSync(out, lines.join('\n'))
console.log('wrote', out)
