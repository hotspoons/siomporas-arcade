#!/usr/bin/env node
// Builds research/rom/sf2ce/system.json from the raw per-character derivations: the numbers that
// are the same for everyone (hit freeze, stun by strength, pushback, timer, dizzy rules, jump physics).
//   node tosystem.mjs <out.json> <raw1.json> [raw2.json ...]
import fs from 'node:fs'
const [outPath, ...raws] = process.argv.slice(2)
const chars = raws.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')))
const seed = JSON.parse(fs.readFileSync(new URL('../../../apps/fighter/src/data/system.json', import.meta.url), 'utf8'))

const byStrength = { light: ['lp', 'lk'], medium: ['mp', 'mk'], heavy: ['hp', 'hk'] }
const collect = (pick) => {
  const out = {}
  for (const [str, btns] of Object.entries(byStrength)) {
    const vals = []
    for (const c of chars) for (const [id, m] of Object.entries(c.normals)) if (btns.some((b) => id.endsWith(b))) { const v = pick(m, id); if (v != null) vals.push(v) }
    out[str] = vals
  }
  return out
}
const mode = (vals) => { const f = {}; for (const v of vals) f[v] = (f[v] ?? 0) + 1; return +Object.entries(f).sort((a, b) => b[1] - a[1])[0]?.[0] }
const stat = (vals) => vals.length ? { mode: mode(vals), min: Math.min(...vals), max: Math.max(...vals), n: vals.length } : null
// single hits only: exclude moves whose defender freeze shows two contacts and knockdowns
const single = (m) => { const h = m.hit ?? m.fhit; return h && !h.knockdown && h.defenderFrozen <= 16 ? h : null }
const singleB = (m) => { const b = m.block ?? m.fblock ?? m.cblock; return b && b.defenderFrozen <= 16 && !(b.damage?.max > 0) ? b : null }
const hitstop = collect((m) => single(m)?.hitstop)
const defFrz = collect((m) => single(m)?.defenderFrozen)
const hitstun = collect((m) => single(m)?.stunAfterFreeze)
const blockstun = collect((m) => singleB(m)?.stunAfterFreeze)
const pushHit = collect((m) => single(m)?.pushback?.mean)
const pushBlock = collect((m) => singleB(m)?.pushback?.mean)
const dizzyAdd = collect((m) => single(m)?.stun ? [single(m).stun.min, single(m).stun.max] : null)
const dizzyTimer = collect((m) => single(m)?.stunTimerAdd)
const dmg = collect((m) => single(m)?.damage?.mean)
const flat = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, stat(v.flat ? v.flat() : v)]))

const kd = chars.map((c) => c.normals['crouch-hk']?.hit?.stuckFrames).filter(Boolean)
const thr = chars.flatMap((c) => Object.values(c.throws).map((t) => t.damageFrame)).filter((x) => x != null)
const thrStuck = chars.flatMap((c) => Object.values(c.throws).map((t) => t.defenderStuck)).filter((x) => x != null)
const dz = chars.flatMap((c) => c.dizzy?.thresholdProbe ?? [])
const dizzyFrames = chars.map((c) => c.dizzy?.hp?.dizzyFrames).filter(Boolean)
const g = chars.map((c) => ({ id: c.id, gravity: c.calib.jumpNeutral?.gravity, vy0: c.calib.jumpNeutral?.vy0, prejump: c.calib.jumpForward?.prejumpFrames, walkFwd: c.calib.walkFwd, walkBack: c.calib.walkBack, landing: c.calib.landingRecovery, airAttackLanding: c.normals['air-hp']?.landingRecovery }))

const out = {
  $comment: 'Street Fighter II: Champion Edition (sf2ceea, MAME 0.276) system numbers measured by tools/sf2-probe. Frames are 60Hz. Same shape as apps/fighter/src/data/system.json; fields the ROM has no single answer for keep the seed value and say so in $notes.',
  fps: 60, screen: [384, 224], floorScreenY: 200, health: 144, roundSeconds: 99, roundsToWin: 2,
  introFrames: seed.introFrames, koFrames: seed.koFrames, stageHalf: seed.stageHalf, maxSpread: seed.maxSpread,
  gravity: chars[0].calib.jumpNeutral?.gravity ?? seed.gravity,
  prejumpFrames: mode(g.map((x) => x.prejump).filter(Boolean)),
  landingFrames: mode(g.map((x) => x.landing).filter((x) => x != null)),
  airAttackLandingFrames: mode(g.map((x) => x.airAttackLanding).filter((x) => x != null)),
  hitstop: { light: mode(hitstop.light), medium: mode(hitstop.medium), heavy: mode(hitstop.heavy) },
  defenderFreeze: { light: mode(defFrz.light), medium: mode(defFrz.medium), heavy: mode(defFrz.heavy) },
  hitstun: { light: mode(hitstun.light), medium: mode(hitstun.medium), heavy: mode(hitstun.heavy) },
  blockstun: { light: mode(blockstun.light), medium: mode(blockstun.medium), heavy: mode(blockstun.heavy) },
  pushback: { hit: mode(pushHit.light), block: mode(pushBlock.light), mediumHit: mode(pushHit.medium), mediumBlock: mode(pushBlock.medium), heavyHit: mode(pushHit.heavy), heavyBlock: mode(pushBlock.heavy) },
  chipFraction: 0.25, comboScaling: false,
  knockdownFrames: mode(kd), wakeupInvuln: seed.wakeupInvuln,
  stun: { light: Math.round(dizzyAdd.light.reduce((a, [lo, hi]) => a + (lo + hi) / 2, 0) / dizzyAdd.light.length), medium: Math.round(dizzyAdd.medium.reduce((a, [lo, hi]) => a + (lo + hi) / 2, 0) / dizzyAdd.medium.length), heavy: Math.round(dizzyAdd.heavy.reduce((a, [lo, hi]) => a + (lo + hi) / 2, 0) / dizzyAdd.heavy.length), special: 15, decayEvery: null, threshold: 30, dizzyFrames: Math.round(dizzyFrames.reduce((a, b) => a + b, 0) / dizzyFrames.length) },
  throw: { hold: mode(thr), knockdown: true, meter: seed.throw.meter, victimStuck: mode(thrStuck) },
  meter: seed.meter,
  timer: { framesPerTick: chars[0].calib.timerFramesPerTick, realSecondsPerTick: +(chars[0].calib.timerFramesPerTick / 59.637).toFixed(3), roundRealSeconds: +((99 * chars[0].calib.timerFramesPerTick) / 59.637).toFixed(1) },
  $notes: {
    hitstop: 'attacker animation freeze on contact, identical for every strength; the defender freezes 2 frames longer (defenderFreeze)',
    hitstun: 'frames from the end of the attacker freeze until the defender can act (jump input accepted); block stun is 1 frame longer because the guard pose is held one extra frame',
    pushback: 'total defender slide in px on a mid-screen hit: light 30, medium 54, heavy 78, identical on block; the slide decelerates (8,8,8,7,7,7,6,5,5,4,3,2,1...)',
    stun: 'dizzy points per hit are random within a strength band (see stunRanges); the meter is cleared when its timer (stunTimer, reset by each hit to the value listed) runs out',
    dizzy: 'dizzy when the meter would exceed 30 (30 survives, 31 does not; probe pokes 22..29 then a jab); dizzy lasts dizzyFrames if nobody mashes',
    knockdownFrames: 'sweep: hit to the first frame the victim can act, including the 14 frame freeze',
    landingFrames: 'empty jump landing: a normal is accepted on the frame after touchdown; landing after an air attack is airAttackLandingFrames',
    kept: 'introFrames, koFrames, stageHalf, maxSpread, wakeupInvuln, meter, chipFraction were not measured',
  },
  measured: {
    hitstop: flat(hitstop), defenderFreeze: flat(defFrz), hitstun: flat(hitstun), blockstun: flat(blockstun),
    pushbackHit: flat(pushHit), pushbackBlock: flat(pushBlock), damage: flat(dmg),
    stunRanges: { light: stat(dizzyAdd.light.flat()), medium: stat(dizzyAdd.medium.flat()), heavy: stat(dizzyAdd.heavy.flat()) },
    stunTimer: flat(dizzyTimer), knockdownStuck: kd, throwDamageFrame: thr, throwVictimStuck: thrStuck, dizzyThresholdProbe: dz, dizzyFrames, perCharacter: g,
  },
}
fs.writeFileSync(outPath, JSON.stringify(out, null, 1))
console.log('wrote', outPath)
