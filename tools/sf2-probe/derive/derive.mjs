#!/usr/bin/env node
// Turns a recorder JSONL log into a distilled character JSON.
//   node derive.mjs <log.jsonl> <out.json> [--char ryu] [--romset sf2ceea]
//
// Conventions (documented in ../README.md):
//   * Frames are 60Hz emulator frames. A move's frame 1 is the first frame on which the game has
//     accepted the input (state byte changed); the old pose is still drawn on that frame.
//   * startup  = frames before the first frame with a live attack box (so the move hits on frame startup+1)
//   * active   = frames with a live attack box (whiff run, no hit-freeze)
//   * recovery = frames after the last active frame until the fighter is back in a neutral state
//   * boxes are fighter-local: origin at the feet, +x forward, +y up, [x0, y0, x1, y1]
//   * hitstop  = frames the attacker's animation is frozen on contact (the defender freezes 2 longer)
//   * hitstun/blockstun = frames from the end of the ATTACKER's freeze until the defender can act
import fs from 'node:fs'

const args = process.argv.slice(2)
const logPath = args[0], outPath = args[1]
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const CHAR = opt('--char', 'ryu'), ROMSET = opt('--romset', 'sf2ceea')

// Logs run to hundreds of MB (per-frame OBJ lists and raw struct bytes), so parse line by line and
// drop what the derivation never reads: the raw struct hex on every frame and P2's sprite list.
const tests = new Map()
{
  const buf = fs.readFileSync(logPath, 'utf8')
  let pos = 0
  while (pos < buf.length) {
    let nl = buf.indexOf('\n', pos); if (nl < 0) nl = buf.length
    const line = buf.slice(pos, nl); pos = nl + 1
    if (!line) continue
    const r = JSON.parse(line)
    delete r.p1.r0; delete r.p1.r1; delete r.p2.r0; delete r.p2.r1; delete r.p2.obj
    if (!/__(whiff|cwhiff|nwhiff)__/.test(r.test)) delete r.p1.obj
    for (const q of r.proj) delete q.r0
    if (!tests.has(r.test)) tests.set(r.test, []); tests.get(r.test).push(r)
  }
}

const FLOOR_Y = 40
const STUCK = new Set([0x0e, 0x14, 0x06, 0x08])
const localBox = (b) => [-b.cx - b.rx, b.cy - b.ry, -b.cx + b.rx, b.cy + b.ry]
const fx = (v) => Math.round((v / 65536) * 1000) / 1000
const hex = (n) => n.toString(16).padStart(2, '0')

// --- parsing one test --------------------------------------------------------------------------
function moveStart(rs) {
  // first frame after a button press where P1's (st, sub) or anim changes
  const pressIdx = rs.findIndex((r) => /[lmh][pk]/.test(r.in1))
  if (pressIdx < 0) return -1
  for (let i = pressIdx + 1; i < rs.length; i++) {
    const a = rs[i - 1].p1, b = rs[i].p1
    if (a.st !== b.st || a.sub !== b.sub || (a.an !== b.an && a.st !== 0 && a.sub === 0)) return i
  }
  return -1
}
function neutralAfter(rs, start, stance) {
  // first frame after start where P1 is back to a neutral state for its stance
  for (let i = start + 1; i < rs.length; i++) {
    const p = rs[i].p1
    if (stance === 'air') { if (p.y === FLOOR_Y && p.st !== 0x04) return i; if (p.y === FLOOR_Y && p.st === 0x04 && p.sub === 0x04) return i }
    else if (stance === 'crouch') { if (p.st === 0x02 || p.st === 0x00) return i }
    else if (p.st === 0x00) return i
  }
  return rs.length
}
function frameTable(rs, start, end) {
  // collapse frames into animation records: [{an, n, dur, atk, hurt, push, rec, obj}]
  const out = []
  for (let i = start; i < end; i++) {
    const p = rs[i].p1
    const atk = p.bx.filter((b) => b.t === 'atk').map((b) => ({ id: b.id, box: localBox(b), raw: b.raw }))
    const hurt = p.bx.filter((b) => b.t.startsWith('v')).map((b) => ({ id: b.id, box: localBox(b) }))
    const push = p.bx.filter((b) => b.t === 'push').map((b) => localBox(b))[0]
    const last = out[out.length - 1]
    if (last && last.an === p.an && JSON.stringify(last.atk) === JSON.stringify(atk)) { last.n++; continue }
    out.push({ an: p.an, n: 1, dur: parseInt(p.rec.slice(2, 4), 16), atk, hurt, push, rec: p.rec, spr: p.rec.slice(8, 16), obj: p.obj, x: p.x, y: p.y - FLOOR_Y, f: i - start + 1 })
  }
  return out
}
function analyseWhiff(rs, stance, special) {
  let start = moveStart(rs)
  // specials: anchor on the special-move state (0x0C); a mashed special may follow a normal
  if (special) { const sp = rs.findIndex((r) => r.p1.st === 0x0c); if (sp >= 0) start = sp }
  if (start < 0) return null
  const end = neutralAfter(rs, start, stance)
  const frames = frameTable(rs, start, end)
  const activeIdx = []
  for (let i = start; i < end; i++) if (rs[i].p1.bx.some((b) => b.t === 'atk') && rs[i].p1.st !== 0) activeIdx.push(i - start)
  const total = end - start
  const startup = activeIdx.length ? activeIdx[0] : null
  const active = activeIdx.length
  const recovery = activeIdx.length ? total - 1 - activeIdx[activeIdx.length - 1] : null
  // union hitbox over the active frames, and per-frame list
  const hit = []
  for (const i of activeIdx) for (const b of rs[start + i].p1.bx) if (b.t === 'atk') hit.push({ f: i + 1, box: localBox(b), id: b.id, raw: b.raw })
  const union = hit.length ? hit.reduce((u, h) => [Math.min(u[0], h.box[0]), Math.min(u[1], h.box[1]), Math.max(u[2], h.box[2]), Math.max(u[3], h.box[3])], [1e9, 1e9, -1e9, -1e9]) : null
  const proj = []
  for (let i = start; i < end + 60 && i < rs.length; i++) for (const q of rs[i].proj) proj.push({ f: i - start + 1, x: q.x - rs[start].p1.x, y: q.y - FLOOR_Y, an: q.an, atk: q.bx.filter((b) => b.t === 'atk').map((b) => localBox(b)), push: q.bx.filter((b) => b.t === 'push').map((b) => localBox(b)) })
  const move = { startup, active, recovery, total, activeFrames: activeIdx.map((i) => i + 1), hitbox: union, hitboxes: hit, frames, stateByte: rs[start].p1.st, moveId: parseInt(rs[start + 1]?.p1.rec.slice(46, 48) ?? 'ff', 16), firstAnim: rs[start + 1]?.p1.an }
  if (proj.length && !activeIdx.length) {
    // projectile moves: "startup" is the frames before the fireball exists, recovery the rest
    move.startup = proj[0].f - 1; move.active = 1; move.recovery = total - proj[0].f
    const xs = proj.filter((q) => q.f > proj[0].f + 2 && q.f < proj[0].f + 12).map((q) => q.x)
    move.projectile = { spawnFrame: proj[0].f, at: [proj[0].x, proj[0].y], speed: xs.length > 1 ? Math.round(((xs[xs.length - 1] - xs[0]) / (xs.length - 1)) * 100) / 100 : null, box: proj[0].atk[0], pushBox: proj[0].push[0], anims: [...new Set(proj.map((q) => q.an))], lifetimeSeen: proj[proj.length - 1].f - proj[0].f + 1 }
  }
  if (stance === 'air') {
    let i = end; while (i < rs.length && rs[i].p1.st !== 0) i++
    move.landingRecovery = i - end
    move.pressedAtHeight = rs[start].p1.y - FLOOR_Y
  }
  if (rs[start].p1.fl !== undefined) {
    // travel: displacement of the fighter over the move
    move.travel = { dx: rs[end - 1]?.p1.x - rs[start].p1.x, maxY: Math.max(...rs.slice(start, end).map((r) => r.p1.y)) - FLOOR_Y }
  }
  if (proj.length) move.projectileTrack = proj
  return move
}
function analyseContact(rs, kind, isThrow) {
  // kind: hit | block | chit | cblock | fhit | fblock. Throws have no freeze: contact is the frame
  // the dummy's animation is taken over, and the damage lands later in the animation.
  let H = rs.findIndex((r) => r.p2.frz !== 0)
  if (isThrow) {
    const s = moveStart(rs)
    const hpDrop = rs.findIndex((r) => r.p2.hp < 144)
    if (s < 0 || hpDrop < 0) return null
    H = s
  }
  if (H < 0) return null
  const before = rs[H - 1] ?? rs[0]
  const hp0 = before.p2.hp
  const hpMin = Math.min(...rs.slice(H).map((r) => r.p2.hp))
  const stunBefore = before.p2.stun, stunAfter = rs[Math.min(H + 2, rs.length - 1)].p2.stun
  const p1frz = Math.max(...rs.map((r) => r.p1.frz))
  const p2frozen = rs.filter((r) => r.p2.frz > 0).length
  const dizzy = stunAfter === 0 && stunBefore > 0 && !isThrow
  const timerBefore = before.p2.stunT, timerAfter = rs[Math.min(H + 1, rs.length - 1)].p2.stunT
  // defender actionable: first frame after H+2 where the dummy is in a free state
  let A = -1
  if (isThrow) {
    const dmgAt = rs.findIndex((r) => r.p2.hp < hp0)
    for (let i = dmgAt + 1; i < rs.length; i++) if (rs[i].p2.st === 0x04) { A = i; break }
  } else for (let i = H + 3; i < rs.length; i++) { const st = rs[i].p2.st; if (!STUCK.has(st) && !(st === 0 && rs[i].p2.sub === 0 && rs[i].in2 === '') ) { A = i; break } }
  const p2x = (i) => rs[Math.min(i, rs.length - 1)].p2.x
  const stuck = A >= 0 ? A - H : null
  const attackerFreeze = p1frz
  // knocked down: the dummy left the floor during the reaction, or stayed stuck far longer than any
  // stagger (staggers are at most ~45 frames; knockdowns 90+; dizzy is flagged separately)
  const airborne = rs.slice(H + 1, A > 0 ? A : rs.length).some((r) => r.p2.y !== FLOOR_Y)
  const knockdown = !dizzy && (isThrow || airborne || (stuck != null && stuck > 60) || (stuck == null && rs.length - H > 80))
  const damageFrame = rs.findIndex((r, i) => i >= H && r.p2.hp < hp0)
  return {
    frame: H + 1, damage: hp0 - hpMin, damageFrame: damageFrame >= 0 ? damageFrame - H + 1 : null,
    stun: dizzy ? null : (isThrow ? rs[Math.min(damageFrame + 2, rs.length - 1)].p2.stun - stunBefore : stunAfter - stunBefore), dizzy, knockdown,
    stunTimerAdd: isThrow ? null : (timerBefore === 0 ? timerAfter : null),
    hitstopAttacker: attackerFreeze, defenderFrozen: p2frozen,
    stuckFrames: stuck, stunAfterFreeze: stuck != null ? stuck - attackerFreeze : null,
    pushback: A >= 0 ? p2x(A) - p2x(H) : p2x(rs.length - 1) - p2x(H),
    p2StateSeq: compress(rs.slice(H, Math.min(rs.length, H + 400)).map((r) => hex(r.p2.st))),
  }
}
function compress(seq) { const o = []; for (const s of seq) { const l = o[o.length - 1]; if (l && l[0] === s) l[1]++; else o.push([s, 1]) } return o.map(([s, n]) => (n > 1 ? `${s}x${n}` : s)).join(' ') }

// --- groups -----------------------------------------------------------------------------------
const groups = new Map()
for (const [name, rs] of tests) {
  const m = name.match(/^(.+?)__(\w+)__(\d+)$/)
  if (!m) continue
  const [, move, variant, rep] = m
  if (!groups.has(move)) groups.set(move, {})
  const g = groups.get(move)
  ;(g[variant] ??= []).push({ rep: +rep, rs })
}

const stanceOf = (id) => (id.startsWith('crouch') ? 'crouch' : id.startsWith('air') ? 'air' : 'stand')
const summarise = (vals) => vals.length ? { min: Math.min(...vals), max: Math.max(...vals), mean: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100, n: vals.length, samples: vals } : null

function buildMove(id, g, stance, special) {
  const whiffs = (g.whiff ?? []).map((w) => analyseWhiff(w.rs, stance, special)).filter(Boolean)
  const cwhiffs = (g.cwhiff ?? []).map((w) => analyseWhiff(w.rs, stance, special)).filter(Boolean)
  const out = { id }
  const w = whiffs[0]
  if (w) Object.assign(out, { firstAnim: w.firstAnim, startup: w.startup, active: w.active, recovery: w.recovery, total: w.total, activeFrames: w.activeFrames, hitbox: w.hitbox, hitboxes: w.hitboxes, frames: w.frames, moveId: w.moveId, travel: w.travel })
  if (w?.projectileTrack) out.projectileTrack = w.projectileTrack
  if (cwhiffs[0] && cwhiffs[0].firstAnim !== w?.firstAnim) {
    const c = cwhiffs[0]
    out.close = { startup: c.startup, active: c.active, recovery: c.recovery, total: c.total, activeFrames: c.activeFrames, hitbox: c.hitbox, hitboxes: c.hitboxes, frames: c.frames, moveId: c.moveId, firstAnim: c.firstAnim }
  }
  if (w?.landingRecovery != null) { out.landingRecovery = w.landingRecovery; out.pressedAtHeight = w.pressedAtHeight }
  if (w?.projectile) out.projectile = w.projectile
  for (const variant of ['hit', 'fhit', 'block', 'fblock', 'chit', 'cblock']) {
    const cs = (g[variant] ?? []).map((v) => { const sp = special ? v.rs.findIndex((r) => r.p1.st === 0x0c) : -1; return { rep: v.rep, c: analyseContact(v.rs, variant), an: v.rs[(sp >= 0 ? sp : moveStart(v.rs)) + 1]?.p1.an } }).filter((v) => v.c && (!special || (g[variant].find((x) => x.rep === v.rep)?.rs ?? []).some((r) => r.p1.st === 0x0c)))
    if (!cs.length) continue
    const s = {
      n: cs.length, anims: [...new Set(cs.map((v) => v.an))],
      damage: summarise(cs.map((v) => v.c.damage)), stun: summarise(cs.map((v) => v.c.stun).filter((x) => x != null)), stunTimerAdd: cs[0].c.stunTimerAdd,
      hitstop: cs[0].c.hitstopAttacker, defenderFrozen: cs[0].c.defenderFrozen,
      stuckFrames: cs[0].c.stuckFrames, stunAfterFreeze: cs[0].c.stunAfterFreeze,
      pushback: summarise(cs.map((v) => v.c.pushback)), knockdown: cs.some((v) => v.c.knockdown), dizzy: cs.some((v) => v.c.dizzy),
      p2StateSeq: cs[0].c.p2StateSeq,
    }
    out[variant] = s
  }
  return out
}

// --- calibration ------------------------------------------------------------------------------
const calib = {}
const T = (n) => tests.get(n)
if (T('calib-idle__whiff__1')) {
  const rs = T('calib-idle__whiff__1')
  const p = rs[5].p1
  calib.stand = { hurt: p.bx.filter((b) => b.t.startsWith('v')).map(localBox), push: p.bx.filter((b) => b.t === 'push').map(localBox)[0], throwable: p.thrable, anims: [...new Set(rs.map((r) => r.p1.an))] }
  calib.idleFrames = frameTable(rs, 0, rs.length).map((f) => ({ an: f.an, dur: f.dur, spr: f.spr, obj: f.obj }))
  calib.p2 = { char: 'zangief', hurt: rs[5].p2.bx.filter((b) => b.t.startsWith('v')).map(localBox), push: rs[5].p2.bx.filter((b) => b.t === 'push').map(localBox)[0], throwable: rs[5].p2.thrable }
}
if (T('calib-crouch__whiff__1')) {
  const rs = T('calib-crouch__whiff__1')
  const p = rs[20].p1
  calib.crouch = { hurt: p.bx.filter((b) => b.t.startsWith('v')).map(localBox), push: p.bx.filter((b) => b.t === 'push').map(localBox)[0], transitionFrames: rs.findIndex((r) => r.p1.an === p.an) - rs.findIndex((r) => r.p1.st === 0x02) }
}
for (const [k, n] of [['walkFwd', 'calib-walkfwd__whiff__1'], ['walkBack', 'calib-walkback__whiff__1']]) {
  const rs = T(n); if (!rs) continue
  const vs = rs.slice(4, 40).map((r) => r.p1.vx).filter((v) => v !== 0)
  calib[k] = vs.length ? Math.abs(fx(vs[0])) : 0
  calib[k + 'Anims'] = [...new Set(rs.map((r) => r.p1.an))]
}
for (const [k, n] of [['jumpNeutral', 'calib-jumpn__whiff__1'], ['jumpForward', 'calib-jumpf__whiff__1'], ['jumpBack', 'calib-jumpb__whiff__1']]) {
  const rs = T(n); if (!rs) continue
  const airStart0 = rs.findIndex((r) => r.p1.y !== FLOOR_Y)
  const pre = rs.slice(0, airStart0).filter((r) => r.p1.st === 0x04 && r.p1.y === FLOOR_Y).length
  const air = rs.filter((r) => r.p1.y !== FLOOR_Y)
  const first = air[0]
  const land = rs.findIndex((r, i) => i > 0 && rs[i - 1].p1.y !== FLOOR_Y && r.p1.y === FLOOR_Y)
  const airStart = rs.findIndex((r) => r.p1.y !== FLOOR_Y)
  const vys = air.map((r) => fx(r.p1.vy))
  calib[k] = {
    prejumpFrames: pre, airborneFrames: land - airStart + 1, vy0: vys[0], gravity: vys.length > 2 ? Math.round((vys[1] - vys[2]) * 10000) / 10000 : null,
    vx0: fx(first.p1.vx), apex: Math.max(...air.map((r) => r.p1.y)) - FLOOR_Y, dx: rs[land]?.p1.x - rs[airStart].p1.x,
    hurt: air[Math.floor(air.length / 2)].p1.bx.filter((b) => b.t.startsWith('v')).map(localBox), push: air[Math.floor(air.length / 2)].p1.bx.filter((b) => b.t === 'push').map(localBox)[0],
    trajectory: air.map((r) => [r.p1.x - rs[airStart].p1.x, r.p1.y - FLOOR_Y]),
    anims: [...new Set(rs.map((r) => r.p1.an))],
  }
}
if (T('calib-landjab__whiff__1')) {
  const rs = T('calib-landjab__whiff__1')
  const land = rs.findIndex((r, i) => i > 0 && rs[i - 1].p1.y !== FLOOR_Y && r.p1.y === FLOOR_Y)
  const jab = rs.findIndex((r, i) => i > land && r.p1.st === 0x0a)
  calib.landingRecovery = jab > 0 ? jab - land - 1 : null
}
if (T('calib-timer__whiff__1')) {
  const rs = T('calib-timer__whiff__1')
  const ticks = []
  for (let i = 1; i < rs.length; i++) if (rs[i].timer !== rs[i - 1].timer) ticks.push(i)
  calib.timerFramesPerTick = ticks.length > 1 ? ticks[1] - ticks[0] : null
}

// --- normals / throws / specials --------------------------------------------------------------
const normals = {}, specials = {}, throws = {}, ranges = {}, probes = {}
for (const [move, g] of groups) {
  if (move.startsWith('calib')) continue
  if (move.startsWith('range-')) {
    const [, b, d] = move.match(/^range-(\w+)-(\d+)$/)
    const rs = g.probe[0].rs
    const s = moveStart(rs)
    const an = s >= 0 ? rs[s + 1]?.p1.an : null
    const real = rs[0].p2.x - rs[0].p1.x
    ;(ranges[b] ??= []).push({ dist: real, an })
    continue
  }
  if (move.startsWith('throwrange-')) {
    const rs = g.probe[0].rs
    const s = moveStart(rs)
    const real = rs[0].p2.x - rs[0].p1.x
    ;(probes.throwRange ??= []).push({ dist: real, an: s >= 0 ? rs[s + 1]?.p1.an : null, st: s >= 0 ? rs[s].p1.st : null })
    continue
  }
  if (move.startsWith('throw-')) {
    const cs = (g.hit ?? []).map((v) => analyseContact(v.rs, 'hit', true)).filter(Boolean)
    const rs = g.hit?.[0]?.rs
    const s = rs ? moveStart(rs) : -1
    throws[move] = cs.length ? {
      anim: rs[s + 1]?.p1.an, damage: summarise(cs.map((c) => c.damage)), stun: summarise(cs.map((c) => c.stun).filter((x) => x != null)),
      knockdown: true, defenderStuck: cs[0].stuckFrames, p2StateSeq: cs[0].p2StateSeq,
      attackerFrames: rs ? neutralAfter(rs, s, 'stand') - s : null, throwBox: rs ? rs[s + 1]?.p1.thr : null,
      damageFrame: cs[0].damageFrame, victimTrack: rs.slice(s, s + 90).map((r) => [r.p2.x - r.p1.x, r.p2.y - FLOOR_Y]),
    } : { whiffed: true, anim: rs && s >= 0 ? rs[s + 1]?.p1.an : null }
    continue
  }
  if (move.startsWith('dizzyprobe-')) {
    const pre = +move.split('-')[1]
    const res = (g.hit ?? []).map((v) => { const c = analyseContact(v.rs, 'hit'); const H = v.rs.findIndex((r) => r.p2.frz !== 0); return c ? { added: c.dizzy ? null : c.stun, dizzy: c.dizzy, stunAfter: v.rs[Math.min(H + 2, v.rs.length - 1)]?.p2.stun } : null }).filter(Boolean)
    ;(probes.dizzyThreshold ??= []).push({ preloaded: pre, results: res })
    continue
  }
  if (move.startsWith('dizzy-')) {
    const rs = g.hit[0].rs
    const events = []
    for (let i = 1; i < rs.length; i++) {
      const a = rs[i - 1].p2, b = rs[i].p2
      if (b.stun !== a.stun || (b.st === 0x0e && a.st !== 0x0e && b.stun === 0)) events.push({ f: i + 1, stunBefore: a.stun, stunAfter: b.stun, timer: b.stunT, hp: b.hp, st: hex(b.st) })
    }
    const dizzyAt = events.find((e) => e.stunAfter === 0 && e.stunBefore > 0)
    let dizzyFrames = null
    if (dizzyAt) { const i0 = dizzyAt.f - 1; let i = i0; while (i < rs.length && rs[i].p2.st === 0x0e) i++; dizzyFrames = i - i0 }
    probes[move] = { events, dizzyThresholdSeen: dizzyAt ? dizzyAt.stunBefore : null, dizzyFrames }
    continue
  }
  const stance = stanceOf(move)
  const isNormal = /^(stand|crouch|air)-[lmh][pk]$/.test(move)
  const m = buildMove(move, g, isNormal ? stance : 'stand', !isNormal)
  if (isNormal) normals[move] = m
  else specials[move] = m
}
// close ranges: max distance producing the close animation (the far whiff anim is the far one)
const closeRange = {}
for (const [b, list] of Object.entries(ranges)) {
  const far = normals['stand-' + b]?.firstAnim
  const closeD = list.filter((e) => e.an && e.an !== far && e.dist > 0).map((e) => e.dist)
  closeRange[b] = { maxCloseDist: closeD.length ? Math.max(...closeD) : null, minFarDist: Math.min(...list.filter((e) => e.an === far).map((e) => e.dist)), samples: list.sort((a, c) => a.dist - c.dist).map((e) => `${e.dist}:${e.an?.slice(-4)}`) }
}

const out = {
  id: CHAR, romset: ROMSET, source: logPath.replace(/.*\/ext\//, 'ext/'), generated: new Date().toISOString(),
  conventions: 'frames@60Hz; frame 1 = input accepted (old pose drawn); startup = frames before first active frame; boxes [x0,y0,x1,y1] fighter-local, +x forward, +y up, origin at feet; hitstun/blockstun = stunAfterFreeze = frames from end of attacker hitstop until defender acts',
  calib, normals, closeRange, throws, throwRange: probes.throwRange, specials, dizzy: { hp: probes['dizzy-hp'], lp: probes['dizzy-lp'], thresholdProbe: probes.dizzyThreshold },
}
fs.mkdirSync(outPath.replace(/\/[^/]+$/, ''), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(out, null, 1))
console.log(`wrote ${outPath}: ${Object.keys(normals).length} normals, ${Object.keys(specials).length} specials, ${Object.keys(throws).length} throws`)
