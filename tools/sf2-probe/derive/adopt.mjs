#!/usr/bin/env node
// ROM measurements → the game's config files.
//
//   node tools/sf2-probe/derive/adopt.mjs            # ryu zangief blanka + system
//   node tools/sf2-probe/derive/adopt.mjs zangief    # one
//
// Reads apps/fighter/research/rom/sf2ce/<char>.json (what tools/sf2-probe measured out of Champion
// Edition) and writes apps/fighter/src/data/chars/<char>.json in the shape src/sim/Character.ts
// reads. This is the seam between "what the machine did" and "what our game does": everything the
// measurement is confident about is copied; the few things it could not measure (invulnerability
// windows, whiff recoveries of grabs, moves the dummy spoiled) keep a hand value, marked in
// `$hand` so the next measurement can retire them.
//
// Unit conversions worth knowing about:
//  - pushback: the ROM reports the total slide in px (30/54/78). The sim applies a velocity that
//    decays by 0.8 a frame, whose total is v/(1-0.8) = 5v — so v = total/5.
//  - stun after a hit: the ROM counts from the end of the attacker's freeze; so does the sim.
//  - a rising special's `rise` is derived from its measured apex and horizontal travel.

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const ROM = (f) => path.join(ROOT, 'apps/fighter/research/rom/sf2ce', f)
const OUT = (f) => path.join(ROOT, 'apps/fighter/src/data', f)
const read = (f) => JSON.parse(readFileSync(f, 'utf8'))
const write = (f, o) => writeFileSync(f, JSON.stringify(o, null, 2) + '\n')

const wanted = process.argv.slice(2)
const CHARS = ['ryu', 'zangief', 'blanka', 'chunli'].filter((c) => !wanted.length || wanted.includes(c))

const r2 = (n) => Math.round(n * 100) / 100
const box = (b) => b.map(Math.round)

// Things the recorder could not settle, per character. Everything else is measured.
const HAND = {
  ryu: {
    hurtAir: [-22, 14, 14, 84],
    specials: {
      shoryuken: { invuln: [1, 6], strengths: { lp: { rise: { vy: 4.7, vx: 0.6 } }, mp: { rise: { vy: 6.6, vx: 0.95 } }, hp: { rise: { vy: 7.8, vx: 1.3 } } } },
      tatsumaki: { hits: 1, strengths: { lk: { travel: { vx: 4.7 } }, mk: { travel: { vx: 4.9 } }, hk: { travel: { vx: 5.1 } } }, rise: { vy: 2.4, vx: 0 } },
    },
  },
  zangief: {
    hurtAir: [-24, 14, 34, 100],
    normals: { 'crouch-mp': { damage: 14 }, 'crouch-hp': { damage: 18 } },
    specials: {
      spd: { startup: 2, active: 2, recovery: 40, range: 52, hold: 56, strengths: { lp: { damage: 44 }, mp: { damage: 44 }, hp: { damage: 44 } } },
      lariat: { startup: 1, hits: 3, rehit: 14, projectileInvuln: true },
    },
  },
  chunli: {
    hurtAir: [-20, 14, 24, 84],
    specials: {
      // The recorder cannot measure a mashed move: the normal that leads into it spoils the dummy
      // before the special lands, so the per-hit damage and the hit count are set by hand here.
      'lightning-legs': { damage: 6, hits: 6, rehit: 5, startup: 7, active: 10, recovery: 8, chip: 1 },
      // Measured startup includes the charge the test held before releasing it; the kick itself is
      // out in about ten frames.
      'spinning-bird': { startup: 10, damage: 5, hits: 8, rehit: 4, rise: { vy: 3.4, vx: 0 }, travel: { vx: 3.6 }, knockdown: true },
    },
  },
  blanka: {
    hurtAir: [-20, 14, 26, 86],
    specials: {
      'rolling-attack': { bounce: { vx: -4, vy: 5 }, strengths: { lp: { travel: { vx: 4.8 }, active: 25 }, mp: { travel: { vx: 4.0 }, active: 40 }, hp: { travel: { vx: 3.6 }, active: 54 } } },
      'electric-thunder': { hits: 5, rehit: 7, damage: 8, startup: 5, active: 34, recovery: 8 },
    },
  },
}

// Which ROM special id becomes which of ours, and how it is input. CE has no vertical roll.
const SPECIAL_MAP = {
  ryu: { hadouken: ['hadouken', 'qcf', 'P', 'projectile'], shoryuken: ['shoryuken', 'dp', 'P', 'strike'], tatsumaki: ['tatsumaki', 'qcb', 'K', 'strike'] },
  zangief: { spd: ['spd', '360', 'P', 'command-throw'], lariat: ['lariat', 'ppp', 'P', 'strike'] },
  blanka: { rolling: ['rolling-attack', 'charge-back', 'P', 'strike'], electricity: ['electric-thunder', 'mash-p', 'P', 'strike'] },
  chunli: { lightning: ['lightning-legs', 'mash-k', 'K', 'strike'], sbk: ['spinning-bird', 'charge-down', 'K', 'strike'] },
}

const NAMES = {
  ryu: { hadouken: 'Hadouken', shoryuken: 'Shoryuken', tatsumaki: 'Tatsumaki Senpukyaku' },
  zangief: { spd: 'Spinning Piledriver', lariat: 'Double Lariat' },
  blanka: { 'rolling-attack': 'Rolling Attack', 'electric-thunder': 'Electric Thunder' },
  chunli: { 'lightning-legs': 'Hyakuretsukyaku', 'spinning-bird': 'Spinning Bird Kick' },
}

function normal(id, n, hand = {}) {
  const o = {
    startup: n.startup, active: n.active, recovery: n.recovery,
    damage: hand.damage ?? n.damage ?? 10,
    height: n.height ?? (id.startsWith('air') ? 'overhead' : 'mid'),
    hitbox: box(n.hitbox),
  }
  if (n.knockdown) o.knockdown = true
  if (id.startsWith('air')) o.untilLand = true
  if (/-(lp|lk)$/.test(id) && !id.startsWith('air')) o.chain = true
  if (/-(lp|mp|lk|mk)$/.test(id) && !id.startsWith('air')) o.cancel = true
  if (n.stun != null) o.stun = n.stun
  if (hand.damage != null) o.$hand = 'damage: the dummy grabbed instead of taking the strike'
  return o
}

function special(c, romId, s) {
  const [id, motion, button, type] = SPECIAL_MAP[c][romId]
  const hand = HAND[c].specials?.[id] ?? {}
  const strengths = {}
  const keys = button === 'P' ? ['lp', 'mp', 'hp'] : ['lk', 'mk', 'hk']
  const base = { id, name: NAMES[c][id], motion, button, type, anim: id }
  const mid = s.strengths?.[keys[1]] ?? s
  // A grab or a charge release the recorder saw as "instant" still needs a frame to exist in.
  Object.assign(base, {
    startup: Math.max(1, hand.startup ?? mid.startup ?? s.startup ?? 1),
    active: Math.max(1, hand.active ?? mid.active ?? s.active ?? 1),
    recovery: hand.recovery ?? mid.recovery ?? s.recovery ?? 20,
    damage: hand.damage ?? mid.damage ?? s.damage ?? 0,
    height: 'mid',
    hitbox: type === 'strike' ? box(mid.hitbox ?? s.hitbox) : [0, 0, 0, 0],
  })
  if (mid.knockdown ?? s.knockdown) base.knockdown = true
  if (type === 'projectile') {
    const p = mid.projectile ?? s.projectile
    base.projectile = { speed: p.speed, damage: p.damage, hitstun: Math.max(12, (p.hitstun ?? 40) - 16), blockstun: Math.max(10, (p.blockstun ?? 30) - 16), at: box(p.at), anim: 'projectile' }
  }
  if (mid.chip) base.chip = mid.chip
  if (mid.stun) base.stun = mid.stun
  for (const k of ['invuln', 'hits', 'rehit', 'projectileInvuln', 'range', 'hold', 'bounce', 'rise', 'travel']) if (hand[k] !== undefined) base[k] = hand[k]
  for (const k of keys) {
    const v = s.strengths?.[k]
    const o = {}
    if (v) {
      // A hand value for a field is the value for every strength; the ROM's per-strength reading of
      // it was the thing we could not trust.
      for (const f of ['startup', 'active', 'recovery', 'damage', 'chip']) if (hand[f] === undefined && v[f] != null && v[f] > 0 && v[f] !== base[f]) o[f] = v[f]
      if (v.projectile && base.projectile) {
        const pp = {}
        if (v.projectile.speed !== base.projectile.speed) pp.speed = v.projectile.speed
        if (v.projectile.damage !== base.projectile.damage) pp.damage = v.projectile.damage
        if (Object.keys(pp).length) o.projectile = pp
      }
    }
    Object.assign(o, hand.strengths?.[k] ?? {})
    if (Object.keys(o).length) strengths[k] = o
  }
  if (Object.keys(strengths).length) base.strengths = strengths
  base.$rom = `research/rom/sf2ce/${c}.json specials.${romId}`
  return base
}

for (const c of CHARS) {
  const rom = read(ROM(`${c}.json`))
  const seed = read(OUT(`chars/${c}.json`))
  const hand = HAND[c]
  const out = {
    $comment: `Measured out of Street Fighter II: Champion Edition (sf2ceea) by tools/sf2-probe; written by tools/sf2-probe/derive/adopt.mjs. Fields under $hand were not measurable and are hand values. Pixels of a 384x224 screen, 60Hz frames, damage in points of 144.`,
    id: c, name: seed.name, art: seed.art, colors: seed.colors,
    health: 144,
    walkFwd: rom.walkFwd, walkBack: rom.walkBack,
    jump: { vy: r2(rom.jump.vy), vx: r2(rom.jump.vx), gravity: r2(rom.jump.gravity), prejump: rom.jump.prejump },
    bodyHalf: rom.bodyHalf,
    hurt: { stand: box(rom.hurt.stand), crouch: box(rom.hurt.crouch), air: hand.hurtAir },
    dizzyResist: rom.dizzyResist ?? 30,
    throw: { range: (rom.throw.reachOwn ?? 48) + 29, damage: rom.throw.damage, hold: Math.max(20, (rom.throw.damageFrame ?? 40) - 16), name: rom.throw.name ?? seed.throw.name, anim: 'throw' },
    normals: {},
    specials: [],
  }
  const order = ['stand', 'close', 'crouch', 'air']
  const ids = Object.keys(rom.normals).sort((a, b) => order.indexOf(a.split('-')[0]) - order.indexOf(b.split('-')[0]) || a.localeCompare(b))
  for (const id of ids) out.normals[id] = normal(id, rom.normals[id], hand.normals?.[id])
  for (const s of rom.specials) if (SPECIAL_MAP[c][s.id]) out.specials.push(special(c, s.id, s))
  // Dragon punch first, so walking forward into a fireball motion gives the uppercut.
  out.specials.sort((a, b) => (a.motion === 'dp' ? -1 : b.motion === 'dp' ? 1 : 0))
  // Keep any hand-written special the ROM has no counterpart for (Blanka's HF vertical roll).
  for (const s of seed.specials) if (!out.specials.find((o) => o.id === s.id) && s.id === 'vertical-roll') out.specials.push({ ...s, $hand: 'not in Champion Edition; Hyper Fighting move kept for fun' })
  write(OUT(`chars/${c}.json`), out)
  console.log(`${c}: ${Object.keys(out.normals).length} normals, ${out.specials.length} specials`)
}

if (!wanted.length || wanted.includes('system')) {
  const rs = read(ROM('system.json'))
  const seed = read(OUT('system.json'))
  const sys = {
    ...seed,
    $comment: 'System-wide fight rules measured out of Street Fighter II: Champion Edition by tools/sf2-probe (see research/rom/sf2ce/system.json for the raw readings); written by tools/sf2-probe/derive/adopt.mjs. Arcade pixels, 60Hz frames, health 144.',
    gravity: rs.gravity,
    prejumpFrames: rs.prejumpFrames,
    landingFrames: rs.landingFrames,
    airAttackLandingFrames: rs.airAttackLandingFrames,
    hitstop: rs.hitstop,
    defenderFreezeExtra: (rs.defenderFreeze?.light ?? 16) - rs.hitstop.light,
    hitstun: rs.hitstun,
    blockstun: rs.blockstun,
    // Total slide → decaying velocity (see the header).
    pushback: { hit: r2(rs.pushback.hit / 5), block: r2(rs.pushback.block / 5), mediumHit: r2(rs.pushback.mediumHit / 5), mediumBlock: r2(rs.pushback.mediumBlock / 5), heavyHit: r2(rs.pushback.heavyHit / 5), heavyBlock: r2(rs.pushback.heavyBlock / 5) },
    knockdownFrames: 60,
    stun: { light: rs.stun.light, medium: rs.stun.medium, heavy: rs.stun.heavy, special: rs.stun.special, timer: { light: 40, medium: 60, heavy: 80, sweep: 130, special: 120 }, dizzyFrames: rs.stun.dizzyFrames },
    timerFramesPerTick: rs.timer.framesPerTick,
    throw: { ...seed.throw, hold: 56 },
  }
  write(OUT('system.json'), sys)
  console.log('system: written')
}
