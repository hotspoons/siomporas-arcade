#!/usr/bin/env node
// Shapes a raw derive.mjs JSON into apps/fighter's character JSON layout (see
// apps/fighter/src/sim/Character.ts) plus a `rom` block carrying everything the framework has no
// field for yet: per-frame hurt boxes, close-normal ranges, multiple hitboxes per frame, sprite ids.
//   node tochar.mjs <raw.json> <out.json> [--seed apps/fighter/src/data/chars/ryu.json]
import fs from 'node:fs'
const args = process.argv.slice(2)
const raw = JSON.parse(fs.readFileSync(args[0], 'utf8'))
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const seedPath = opt('--seed', null)
const seed = seedPath && fs.existsSync(seedPath) ? JSON.parse(fs.readFileSync(seedPath, 'utf8')) : {}

const r2 = (v) => (v == null ? v : Math.round(v * 100) / 100)
const strengthOf = (id) => ({ l: 'light', m: 'medium', h: 'heavy' })[id.slice(-2, -1)]
const union = (boxes) => boxes.reduce((u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])], [1e9, 1e9, -1e9, -1e9])
// Block height from the dummy tests: a standing blocker that took damage means the move must be
// blocked low; a crouching blocker that took damage means it is an overhead. Air normals are overheads.
const heightOf = (id, m, anim) => {
  if (id.startsWith('air')) return 'overhead'
  const sb = pickContact(m, ['block', 'fblock'], anim), cb = pickContact(m, ['cblock'], anim)
  if (sb && sb.damage?.max > 0 && cb && !(cb.damage?.max > 0)) return 'low'
  if (cb && cb.damage?.max > 0 && sb && !(sb.damage?.max > 0)) return 'overhead'
  return 'mid'
}

// A move's contact data for a given animation (far and close versions share the test pool):
// prefer the standing hit, then the far hit, then crouching, but only tests where that animation came out.
const pickContact = (m, keys, anim) => { for (const k of keys) if (m[k] && (!anim || !m[k].anims || m[k].anims.includes(anim))) return m[k]; return null }
const hitsOf = (h) => (h && h.defenderFrozen > 16 && !h.knockdown ? Math.round(h.defenderFrozen / 15.5) : 1)

// Sprite identity per animation record, collected once: the ROM sprite-list pointer and the CPS1
// OBJ entries the game emitted for that pose ([x, y, tileCode, attr]; HUD rows y < 60 dropped;
// screen position is (x-64, y-16); attr = size<<8 | flipy<<6 | flipx<<5 | palette). The fighter's
// own screen position that frame is recorded so the tiles can be placed relative to the origin.
const sprites = {}
function frameRecords(frames) {
  return (frames ?? []).map((f) => {
    if (f.obj && !sprites[f.an]) sprites[f.an] = { sprite: f.spr, rec: f.rec, obj: f.obj.filter((o) => o[1] >= 60) }
    return {
      f: f.f, n: f.n, dur: f.dur, anim: f.an, sprite: f.spr,
      hurt: f.hurt.map((h) => h.box), push: f.push ?? null, hit: f.atk.map((a) => a.box), hitRaw: f.atk.map((a) => a.raw), dx: f.x, dy: f.y,
    }
  })
}

function normal(id, m, anim = m.firstAnim) {
  const hit = pickContact(m, ['hit', 'fhit', 'chit'], anim)
  const blk = pickContact(m, ['block', 'fblock', 'cblock'], anim)
  const isAir = id.startsWith('air')
  const out = {
    startup: m.startup, active: m.active, recovery: m.recovery, damage: hit?.damage?.mean != null ? Math.round(hit.damage.mean) : null,
    height: heightOf(id, m, anim), hitbox: m.hitbox,
  }
  if (hitsOf(hit) > 1) out.hits = hitsOf(hit)
  if (hit) {
    out.hitstun = hit.stunAfterFreeze; out.hitstop = hit.hitstop; out.stun = hit.stun ? Math.round(hit.stun.mean) : null
    out.pushHit = hit.pushback ? r2(hit.pushback.mean) : null
    if (hit.knockdown) out.knockdown = true
  }
  // the block test that actually blocked (a low hits a standing blocker; use the crouching one then)
  const realBlk = out.height === 'low' ? pickContact(m, ['cblock'], anim) : out.height === 'overhead' ? pickContact(m, ['block', 'fblock'], anim) : blk
  if (realBlk) { out.blockstun = realBlk.stunAfterFreeze; out.pushBlock = realBlk.pushback ? r2(realBlk.pushback.mean) : null; if (realBlk.damage?.max) out.chip = realBlk.damage.max }
  if (isAir) { out.untilLand = m.recovery === 0; out.landingRecovery = m.landingRecovery }
  if (id.endsWith('lp') || id.endsWith('lk')) out.chain = true // jabs/shorts re-cancel into themselves (calib-landjab shows it)
  out.rom = {
    anim: m.firstAnim, moveId: m.moveId, total: m.total, activeFrames: m.activeFrames, hitboxes: m.hitboxes,
    damage: hit?.damage ?? null, dizzy: hit?.stun ?? null, dizzyTimer: hit?.stunTimerAdd ?? null,
    defenderFrozen: hit?.defenderFrozen ?? null, stuckOnHit: hit?.stuckFrames ?? null, stuckOnBlock: blk?.stuckFrames ?? null,
    pushbackOnHit: hit?.pushback ?? null, pushbackOnBlock: blk?.pushback ?? null,
    vsCrouch: m.chit ? { damage: m.chit.damage, stuck: m.chit.stuckFrames, pushback: m.chit.pushback } : null,
    frames: frameRecords(m.frames),
  }
  return out
}

const normals = {}
for (const [id, m] of Object.entries(raw.normals ?? {})) {
  normals[id] = normal(id, m)
  if (m.close) {
    const cid = id.replace('stand-', 'close-')
    const c = m.close
    const cm = { ...m, ...c, hitbox: c.hitbox, frames: c.frames, hitboxes: c.hitboxes, moveId: c.moveId, total: c.total, activeFrames: c.activeFrames, firstAnim: c.firstAnim }
    normals[cid] = normal(cid, cm, c.firstAnim)
    normals[cid].name = `Close ${id.slice(-2).toUpperCase()}`
    normals[cid].rom.maxCloseDist = raw.closeRange?.[id.slice(-2)]?.maxCloseDist ?? null
  }
}

// specials: group ids like hadouken-lp / hadouken-mp / hadouken-hp
const specialGroups = {}
for (const [id, m] of Object.entries(raw.specials ?? {})) {
  const mm = id.match(/^(.*)-([lmh][pk]|ppp|kkk)$/)
  if (!mm) continue
  ;(specialGroups[mm[1]] ??= {})[mm[2]] = m
}
const specials = []
for (const [gid, byStr] of Object.entries(specialGroups)) {
  const seedSp = (seed.specials ?? []).find((s) => s.id === gid) ?? {}
  const keys = Object.keys(byStr)
  const base = byStr.mp ?? byStr.mk ?? byStr[keys[0]]
  const per = (m) => {
    const hit = pickContact(m, ['hit', 'chit'], null)
    const blk = pickContact(m, ['block', 'cblock'], null)
    const o = {
      startup: m.startup, active: m.active, recovery: m.recovery, damage: hit?.damage?.mean != null ? Math.round(hit.damage.mean) : null,
      hitbox: m.hitbox, hitstun: hit?.stunAfterFreeze ?? null, blockstun: blk?.stunAfterFreeze ?? null, hitstop: hit?.hitstop ?? null,
      stun: hit?.stun ? Math.round(hit.stun.mean) : null, chip: blk?.damage?.max ?? 0, knockdown: hit?.knockdown ?? false,
      pushHit: hit?.pushback ? r2(hit.pushback.mean) : null, pushBlock: blk?.pushback ? r2(blk.pushback.mean) : null,
      hits: m.activeFrames?.length ? m.activeFrames.reduce((n, f, i, a) => n + (i === 0 || f !== a[i - 1] + 1 ? 1 : 0), 0) : 0,
      travel: m.travel, height: heightOf(gid, m, null),
    }
    if (m.projectile) { const pb = m.projectile.box ?? m.projectile.pushBox ?? [0, 0, 0, 0]; o.projectile = { speed: m.projectile.speed, damage: o.damage, hitstun: o.hitstun, blockstun: o.blockstun, at: [m.projectile.at[0] + pb[0], m.projectile.at[1] + pb[1], m.projectile.at[0] + pb[2], m.projectile.at[1] + pb[3]], spawnFrame: m.projectile.spawnFrame, anims: m.projectile.anims, pushBox: m.projectile.pushBox, noAttackBoxAtSpawn: !m.projectile.box } }
    o.rom = { anim: m.firstAnim, moveId: m.moveId, total: m.total, activeFrames: m.activeFrames, hitboxes: m.hitboxes, damage: hit?.damage ?? null, dizzy: hit?.stun ?? null, dizzyTimer: hit?.stunTimerAdd ?? null, stuckOnHit: hit?.stuckFrames ?? null, stuckOnBlock: blk?.stuckFrames ?? null, defenderFrozen: hit?.defenderFrozen ?? null, chipSamples: blk?.damage ?? null, frames: frameRecords(m.frames), projectileTrack: m.projectileTrack }
    return o
  }
  const b = per(base)
  const strengths = {}
  for (const k of keys) strengths[k] = per(byStr[k])
  specials.push({
    id: gid, name: seedSp.name ?? gid, motion: seedSp.motion ?? null, button: /k$|kkk/.test(keys[0]) ? 'K' : 'P',
    type: seedSp.type ?? (b.projectile ? 'projectile' : 'strike'), anim: gid,
    ...b, strengths,
  })
}

// throws: pick the strongest connecting one for the framework's single throw field
const throwEntries = Object.entries(raw.throws ?? {}).filter(([, t]) => !t.whiffed)
const primaryThrow = throwEntries.find(([k]) => k === 'throw-fwd-hp')?.[1] ?? throwEntries[0]?.[1]
const throwReach = raw.throwRange ? Math.max(...raw.throwRange.filter((p) => p.an === primaryThrow?.anim).map((p) => p.dist)) : null

const c = raw.calib ?? {}
const jf = c.jumpForward ?? c.jumpNeutral ?? {}
const out = {
  id: raw.id, name: seed.name ?? raw.id.toUpperCase(), art: seed.art ?? raw.id, colors: seed.colors ?? { body: '#cccccc', trim: '#cc3333' },
  health: 144,
  walkFwd: c.walkFwd, walkBack: c.walkBack,
  jump: { vy: c.jumpNeutral?.vy0, vx: jf.vx0, gravity: c.jumpNeutral?.gravity, prejump: c.jumpForward?.prejumpFrames ?? c.jumpNeutral?.prejumpFrames, airborne: c.jumpNeutral?.airborneFrames, apex: c.jumpNeutral?.apex, forwardDx: c.jumpForward?.dx, backDx: c.jumpBack?.dx, backVx: c.jumpBack?.vx0 },
  bodyHalf: c.stand?.push ? c.stand.push[2] : null,
  hurt: { stand: c.stand ? union(c.stand.hurt) : null, crouch: c.crouch ? union(c.crouch.hurt) : null, air: c.jumpNeutral?.hurt ? union(c.jumpNeutral.hurt) : null },
  push: { stand: c.stand?.push, crouch: c.crouch?.push, air: c.jumpNeutral?.push },
  throwable: c.stand?.throwable ? { halfWidth: c.stand.throwable[0], height: c.stand.throwable[1] } : null,
  dizzyResist: raw.dizzy?.thresholdProbe ? 30 : null,
  throw: primaryThrow ? { range: throwReach, reachOwn: primaryThrow.throwBox ? -primaryThrow.throwBox[0] + primaryThrow.throwBox[2] : null, damage: Math.round(primaryThrow.damage.mean), damageFrame: primaryThrow.damageFrame, stun: primaryThrow.stun ? Math.round(primaryThrow.stun.mean) : null, victimStuck: primaryThrow.defenderStuck, attackerFrames: primaryThrow.attackerFrames, throwBox: primaryThrow.throwBox, anim: 'throw', name: seed.throw?.name ?? 'Throw' } : seed.throw ?? null,
  throws: Object.fromEntries(Object.entries(raw.throws ?? {}).map(([k, t]) => [k, t.whiffed ? { whiffed: true } : { anim: t.anim, damage: t.damage, stun: t.stun, damageFrame: t.damageFrame, victimStuck: t.defenderStuck, attackerFrames: t.attackerFrames, throwBox: t.throwBox, victimTrack: t.victimTrack }])),
  normals, specials,
  rom: {
    romset: raw.romset, source: raw.source, generated: raw.generated, conventions: raw.conventions,
    hurtDetail: { stand: c.stand?.hurt, crouch: c.crouch?.hurt, crouchTransitionFrames: c.crouch?.transitionFrames, air: c.jumpNeutral?.hurt },
    idle: (c.idleFrames ?? []).map((f) => { if (f.obj && !sprites[f.an]) sprites[f.an] = { sprite: f.spr, obj: f.obj.filter((o) => o[1] >= 60) }; return { an: f.an, dur: f.dur, spr: f.spr } }),
    sprites, walkAnims: { fwd: c.walkFwdAnims, back: c.walkBackAnims }, jumps: { neutral: c.jumpNeutral, forward: c.jumpForward, back: c.jumpBack },
    landingRecovery: c.landingRecovery, timerFramesPerTick: c.timerFramesPerTick,
    closeRange: raw.closeRange, throwRange: raw.throwRange, dizzy: raw.dizzy, dummy: c.p2,
  },
}
fs.writeFileSync(args[1], JSON.stringify(out, null, 1))
console.log(`wrote ${args[1]} (${Object.keys(normals).length} normals, ${specials.length} specials)`)
