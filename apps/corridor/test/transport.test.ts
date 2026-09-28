// Do the six ways of getting about actually fly differently?
//
// That is the whole claim of having a library rather than a speed constant: a helicopter hovers,
// a plane stalls, a UFO has no inertia, an ornithopter falls between wingbeats. Six kinds that all
// move the camera at 30 m/s would be one kind with six names — and a flight model is exactly the
// sort of code that feels wrong for a week before anybody works out which term is missing, because
// feeling is not a test.
//
// So these tests fly them. Each asks for a BEHAVIOUR, not an equation: can it hold a hover, does
// it fall out of the sky below its stall speed, does a bank turn it, does it stop when you let go.
import { describe, expect, it } from 'vitest'
import {
  CRAFT, CRAFT_KINDS, G, NEUTRAL, angleOfAttack, axes, cameraFor, startState, step,
  type CraftKind, type CraftState, type Controls, type World,
} from '../src/transport'

/** Flat ground at y = 0, everywhere. */
const flat: World = { groundAt: () => 0 }
/** No ground at all, for testing free flight without the clamp getting in the way. */
const sky: World = { groundAt: () => null }

const ctl = (o: Partial<Controls> = {}): Controls => ({ ...NEUTRAL, ...o })

/** Fly `seconds` at 50 Hz and return where it got to. */
function fly(kind: CraftKind, s: CraftState, c: Controls | ((t: number, s: CraftState) => Controls), seconds: number, world = sky) {
  let state = s
  const dt = 0.02
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    state = step(kind, state, typeof c === 'function' ? c(t, state) : c, dt, world)
  }
  return state
}

const speed = (s: CraftState) => Math.hypot(s.vel.x, s.vel.y, s.vel.z)

describe('axes', () => {
  it('points yaw 0 at north, which is -z in three world coordinates', () => {
    const { fwd } = axes(0, 0, 0)
    expect(fwd.z).toBeCloseTo(-1, 6)
    expect(fwd.x).toBeCloseTo(0, 6)
  })

  it('turns east at a quarter turn', () => {
    const { fwd } = axes(Math.PI / 2, 0, 0)
    expect(fwd.x).toBeCloseTo(1, 6)
    expect(fwd.z).toBeCloseTo(0, 6)
  })

  it('raises the nose with pitch and keeps the axes orthonormal', () => {
    for (const [y, p, r] of [[0, 0, 0], [1.1, 0.4, -0.7], [-2.3, -0.9, 2.1]]) {
      const { fwd, right, up } = axes(y, p, r)
      for (const v of [fwd, right, up]) expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 6)
      expect(fwd.x * right.x + fwd.y * right.y + fwd.z * right.z).toBeCloseTo(0, 6)
      expect(fwd.x * up.x + fwd.y * up.y + fwd.z * up.z).toBeCloseTo(0, 6)
      expect(right.x * up.x + right.y * up.y + right.z * up.z).toBeCloseTo(0, 6)
    }
    expect(axes(0, 0.5, 0).fwd.y).toBeGreaterThan(0)
  })

  it('rolls the up vector over without moving the nose', () => {
    const level = axes(0, 0, 0)
    const banked = axes(0, 0, 0.6)
    expect(banked.fwd.x).toBeCloseTo(level.fwd.x, 6)
    expect(banked.fwd.z).toBeCloseTo(level.fwd.z, 6)
    expect(banked.up.y).toBeLessThan(level.up.y)
  })
})

describe('on foot', () => {
  it('walks at a walk and sprints at a run', () => {
    const w = fly('walk', startState({ x: 0, y: 1.7, z: 0 }), ctl({ throttle: 1 }), 2, flat)
    expect(speed(w)).toBeCloseTo(1.45, 2)
    const r = fly('walk', startState({ x: 0, y: 1.7, z: 0 }), ctl({ throttle: 1, boost: true }), 2, flat)
    expect(speed(r)).toBeCloseTo(5.4, 2)
  })

  it('stops the moment you stop asking, because a person is not a vehicle', () => {
    let s = fly('walk', startState({ x: 0, y: 1.7, z: 0 }), ctl({ throttle: 1, boost: true }), 3, flat)
    expect(speed(s)).toBeGreaterThan(5)
    s = step('walk', s, ctl(), 0.02, flat)
    expect(Math.hypot(s.vel.x, s.vel.z)).toBe(0)
  })

  it('keeps the eye at head height over the ground', () => {
    const hill: World = { groundAt: (x) => x / 20 }
    const s = fly('walk', startState({ x: 0, y: 1.7, z: 0 }, Math.PI / 2), ctl({ throttle: 1, boost: true }), 6, hill)
    expect(s.at.x).toBeGreaterThan(20)
    expect(s.at.y - s.at.x / 20).toBeCloseTo(CRAFT.walk.clearance, 1)
    expect(s.grounded).toBe(true)
  })

  it('does not pitch or roll, whatever the stick says', () => {
    const s = fly('walk', startState({ x: 0, y: 1.7, z: 0 }), ctl({ pitch: 1, roll: 1 }), 2, flat)
    expect(s.pitch).toBe(0)
    expect(s.roll).toBe(0)
  })
})

describe('the helicopter', () => {
  it('holds a hover at the collective that balances its weight', () => {
    // thrust = mass × g at this fraction of full power; a machine that cannot hover is not a
    // helicopter, and this is the one number the whole model turns on
    const hover = (CRAFT.helicopter.massKg * G) / CRAFT.helicopter.thrustN
    expect(hover).toBeGreaterThan(0.3)
    expect(hover).toBeLessThan(0.9)
    const s = fly('helicopter', startState({ x: 0, y: 200, z: 0 }), ctl({ throttle: hover }), 8)
    expect(Math.abs(s.at.y - 200)).toBeLessThan(2)
  })

  it('sinks below that and climbs above it', () => {
    const hover = (CRAFT.helicopter.massKg * G) / CRAFT.helicopter.thrustN
    expect(fly('helicopter', startState({ x: 0, y: 400, z: 0 }), ctl({ throttle: hover * 0.6 }), 5).at.y).toBeLessThan(390)
    expect(fly('helicopter', startState({ x: 0, y: 400, z: 0 }), ctl({ throttle: 1 }), 5).at.y).toBeGreaterThan(420)
  })

  it('goes where it is pointed, and only where it is pointed', () => {
    // nose down and it flies forwards; that IS the control, and a separate forward force is how a
    // helicopter ends up handling like a hovercraft
    const s = fly('helicopter', startState({ x: 0, y: 300, z: 0 }), ctl({ throttle: 1, pitch: 0.35 }), 6)
    expect(s.pitch).toBeLessThan(-0.1)
    expect(s.at.z).toBeLessThan(-20) // north, which is -z
  })

  it('never stalls, at any speed', () => {
    const s = fly('helicopter', startState({ x: 0, y: 300, z: 0 }), ctl({ throttle: 0.4 }), 5)
    expect(s.stalled).toBe(false)
  })
})

describe('the plane', () => {
  const fast = (y = 600) => {
    const s = startState({ x: 0, y, z: 0 })
    s.vel = { x: 0, y: 0, z: -70 } // 70 m/s northbound, well above the stall
    return s
  }

  it('flies level at speed, near enough', () => {
    const s = fly('plane', fast(), ctl({ throttle: 0.6 }), 6)
    expect(s.stalled).toBe(false)
    expect(Math.abs(s.at.y - 600)).toBeLessThan(120)
  })

  it('stalls below its stall speed and falls', () => {
    // the one thing that makes a plane a plane: you cannot climb by pointing up
    const slow = startState({ x: 0, y: 600, z: 0 })
    slow.vel = { x: 0, y: 0, z: -8 }
    let state = slow
    let everStalled = false
    for (let i = 0; i < 200; i += 1) {
      state = step('plane', state, ctl({ throttle: 0, pitch: -1 }), 0.02, sky)
      everStalled ||= state.stalled
    }
    expect(everStalled).toBe(true)
    expect(state.at.y).toBeLessThan(560)
    // and it is STILL stalled at the end: it is falling faster than its stall speed, but straight
    // down through a nose-up attitude, which is past the critical angle
    expect(state.stalled).toBe(true)
  })

  it('can be flown out of a stall by dropping the nose and gaining speed', () => {
    const slow = startState({ x: 0, y: 900, z: 0 })
    slow.vel = { x: 0, y: 0, z: -8 }
    // nose down, full power, for long enough to get the airspeed back
    const s = fly('plane', slow, ctl({ throttle: 1, pitch: 0.5 }), 14)
    expect(speed(s)).toBeGreaterThan(CRAFT.plane.stallMs)
    expect(s.stalled).toBe(false)
  })

  it('turns by banking, not by yawing', () => {
    // g·tan(bank)/v — which is why a fast aircraft turns lazily and a slow one pivots
    const banked = fly('plane', fast(), (t, s) => ctl({ throttle: 0.6, roll: s.roll < 0.7 ? 1 : 0 }), 8)
    const straight = fly('plane', fast(), ctl({ throttle: 0.6 }), 8)
    expect(Math.abs(banked.yaw - straight.yaw)).toBeGreaterThan(0.5)
    // and the rudder alone barely does anything, which is what a rudder is for
    const ruddered = fly('plane', fast(), ctl({ throttle: 0.6, yaw: 1 }), 8)
    expect(Math.abs(ruddered.yaw - straight.yaw)).toBeLessThan(Math.abs(banked.yaw - straight.yaw))
  })

  it('turns harder when it is slower, at the same bank', () => {
    const at = (v: number) => {
      const s = startState({ x: 0, y: 3000, z: 0 })
      s.vel = { x: 0, y: 0, z: -v }
      s.roll = 0.8
      return Math.abs(fly('plane', s, ctl({ throttle: 0.6, roll: 0.02 }), 4).yaw)
    }
    expect(at(40)).toBeGreaterThan(at(110))
  })
})

describe('starting a craft', () => {
  it('gives a wing approach speed when it starts in the air, so it is flying and not falling', () => {
    // a plane handed to somebody at 100 m with no airspeed is correct physics and an unusable
    // mode: stalled on the first frame, with nothing to do but hit the ground
    for (const kind of ['plane', 'jet', 'ornithopter'] as const) {
      const s = startState({ x: 0, y: 900, z: 0 }, 0, { airborne: true, kind })
      expect(speed(s), kind).toBeGreaterThan(CRAFT[kind].stallMs)
      const flown = fly(kind, s, ctl({ throttle: 0.7 }), 3)
      expect(flown.stalled, kind).toBe(false)
    }
  })

  it('starts a wing at rest on the ground, which is a take-off run', () => {
    const s = startState({ x: 0, y: 1.2, z: 0 }, 0, { airborne: false, kind: 'plane' })
    expect(speed(s)).toBe(0)
  })

  it('gives the hovering craft nothing, because they do not need it', () => {
    for (const kind of ['helicopter', 'omnicopter', 'ufo', 'walk'] as const) {
      expect(speed(startState({ x: 0, y: 900, z: 0 }, 0, { airborne: true, kind })), kind).toBe(0)
    }
  })

  it('points the airspeed along the heading it was given', () => {
    const s = startState({ x: 0, y: 900, z: 0 }, Math.PI / 2, { airborne: true, kind: 'plane' })
    expect(s.vel.x).toBeGreaterThan(0) // east
    expect(Math.abs(s.vel.z)).toBeLessThan(1e-9)
  })
})

describe('the jet', () => {
  const fast = () => {
    const s = startState({ x: 0, y: 2000, z: 0 })
    s.vel = { x: 0, y: 0, z: -180 }
    return s
  }

  it('goes a great deal faster than the light aircraft', () => {
    const jet = fly('jet', fast(), ctl({ throttle: 1 }), 20)
    const plane = fly('plane', (() => { const s = startState({ x: 0, y: 2000, z: 0 }); s.vel = { x: 0, y: 0, z: -70 }; return s })(), ctl({ throttle: 1 }), 20)
    expect(speed(jet)).toBeGreaterThan(speed(plane) * 2)
  })

  it('goes faster still on the afterburner', () => {
    const dry = speed(fly('jet', fast(), ctl({ throttle: 1 }), 12))
    const wet = speed(fly('jet', fast(), ctl({ throttle: 1, boost: true }), 12))
    expect(wet).toBeGreaterThan(dry * 1.1)
  })

  it('stalls at a much higher speed than the light aircraft', () => {
    expect(CRAFT.jet.stallMs).toBeGreaterThan(CRAFT.plane.stallMs * 2)
  })

  it('slows down on the air brake', () => {
    const free = speed(fly('jet', fast(), ctl({ throttle: 0 }), 10))
    const braked = speed(fly('jet', fast(), ctl({ throttle: 0, brake: true }), 10))
    expect(braked).toBeLessThan(free * 0.8)
  })
})

describe('the ornithopter', () => {
  it('rises and falls within a wingbeat instead of climbing smoothly', () => {
    // the whole reason it is in the library rather than being a slow plane
    const s = startState({ x: 0, y: 400, z: 0 })
    s.vel = { x: 0, y: 0, z: -12 }
    const ys: number[] = []
    let state = s
    for (let i = 0; i < 200; i += 1) {
      state = step('ornithopter', state, ctl({ throttle: 1 }), 0.02, sky)
      ys.push(state.vel.y)
    }
    // the vertical speed must change sign within the run: up on the downstroke, down between
    expect(Math.max(...ys)).toBeGreaterThan(0)
    expect(Math.min(...ys)).toBeLessThan(0)
  })

  it('advances its wing phase and wraps it', () => {
    const s = fly('ornithopter', startState({ x: 0, y: 400, z: 0 }), ctl({ throttle: 1 }), 3)
    expect(s.phase).toBeGreaterThanOrEqual(0)
    expect(s.phase).toBeLessThan(1)
  })

  it('flaps harder with more throttle and gets further', () => {
    const at = (throttle: number) => {
      const s = startState({ x: 0, y: 400, z: 0 })
      s.vel = { x: 0, y: 0, z: -12 }
      return Math.abs(fly('ornithopter', s, ctl({ throttle }), 6).at.z)
    }
    expect(at(1)).toBeGreaterThan(at(0.3))
  })
})

describe('the omnicopter', () => {
  it('climbs without tilting, which is the point of it', () => {
    const hover = (CRAFT.omnicopter.massKg * G) / CRAFT.omnicopter.thrustN
    const s = fly('omnicopter', startState({ x: 0, y: 50, z: 0 }), ctl({ throttle: hover, lift: 1 }), 3)
    expect(s.at.y).toBeGreaterThan(55)
    expect(Math.abs(s.pitch)).toBeLessThan(0.05)
  })

  it('holds a hover like a helicopter does', () => {
    const hover = (CRAFT.omnicopter.massKg * G) / CRAFT.omnicopter.thrustN
    const s = fly('omnicopter', startState({ x: 0, y: 50, z: 0 }), ctl({ throttle: 0, lift: hover * 1.25 }), 6)
    expect(Math.abs(s.at.y - 50)).toBeLessThan(6)
  })
})

describe('the UFO', () => {
  it('starts and stops instantly, because it has no inertia', () => {
    let s = fly('ufo', startState({ x: 0, y: 300, z: 0 }), ctl({ throttle: 1 }), 2)
    expect(speed(s)).toBeCloseTo(45, 1)
    s = step('ufo', s, ctl(), 0.02, sky)
    expect(speed(s)).toBe(0)
  })

  it('ignores gravity entirely', () => {
    const s = fly('ufo', startState({ x: 0, y: 300, z: 0 }), ctl(), 10)
    expect(s.at.y).toBe(300)
  })

  it('never banks or pitches, whatever the stick does', () => {
    const s = fly('ufo', startState({ x: 0, y: 300, z: 0 }), ctl({ pitch: 1, roll: 1, throttle: 1 }), 4)
    expect(s.pitch).toBe(0)
    expect(s.roll).toBe(0)
  })

  it('goes straight up and straight down', () => {
    expect(fly('ufo', startState({ x: 0, y: 300, z: 0 }), ctl({ lift: 1 }), 2).at.y).toBeGreaterThan(300)
    expect(fly('ufo', startState({ x: 0, y: 300, z: 0 }), ctl({ lift: -1 }), 2).at.y).toBeLessThan(300)
  })
})

describe('every craft', () => {
  it('stays above the ground', () => {
    for (const kind of CRAFT_KINDS) {
      const s = fly(kind, startState({ x: 0, y: 40, z: 0 }), ctl({ pitch: -1, lift: -1 }), 20, flat)
      expect(s.at.y, kind).toBeGreaterThanOrEqual(CRAFT[kind].clearance - 1e-6)
    }
  })

  it('comes to rest on the ground rather than skating off it', () => {
    for (const kind of CRAFT_KINDS) {
      if (kind === 'ufo') continue // it has no inertia to lose
      const s = fly(kind, startState({ x: 0, y: 3, z: 0 }), ctl(), 25, flat)
      expect(Math.hypot(s.vel.x, s.vel.z), kind).toBeLessThan(1)
    }
  })

  it('produces a finite state from any input, for a hundred seconds', () => {
    // a flight model that goes to NaN does not throw; it puts the camera nowhere and the screen
    // goes black, which is a bug report about the renderer
    for (const kind of CRAFT_KINDS) {
      const s = fly(kind, startState({ x: 0, y: 500, z: 0 }), (t) => ctl({
        pitch: Math.sin(t * 3), roll: Math.cos(t * 2), yaw: Math.sin(t), throttle: (Math.sin(t * 5) + 1) / 2,
        lift: Math.cos(t * 4), boost: t % 2 < 1, brake: t % 3 < 1,
      }), 100, flat)
      for (const v of [s.at.x, s.at.y, s.at.z, s.vel.x, s.vel.y, s.vel.z, s.yaw, s.pitch, s.roll, s.phase]) {
        expect(Number.isFinite(v), `${kind}: ${v}`).toBe(true)
      }
    }
  })

  it('is described for a picker', () => {
    for (const kind of CRAFT_KINDS) {
      expect(CRAFT[kind].name, kind).toBeTruthy()
      expect(CRAFT[kind].note, kind).toBeTruthy()
    }
  })
})

describe('the program layer and the library agree', () => {
  it('names the same craft in both places', async () => {
    // `api.transport('helicopter')` in a program and `setCraft('helicopter')` in the viewer must
    // mean the same thing; a name in one list and not the other is a transport that silently does
    // nothing, and the program would be right to expect it to work
    const { CRAFT_TRANSPORT, TRANSPORT } = await import('../src/program')
    expect([...CRAFT_TRANSPORT].sort()).toEqual([...CRAFT_KINDS].sort())
    for (const k of CRAFT_TRANSPORT) expect(TRANSPORT, k).toContain(k)
  })
})

describe('angleOfAttack', () => {
  it('is zero flying straight along the nose', () => {
    const { fwd, up } = axes(0, 0, 0)
    expect(angleOfAttack({ x: 0, y: 0, z: -60 }, fwd, up)).toBeCloseTo(0, 6)
  })

  it('is positive when the aircraft is sinking through its own nose-up attitude', () => {
    const { fwd, up } = axes(0, 0.2, 0)
    expect(angleOfAttack({ x: 0, y: 0, z: -60 }, fwd, up)).toBeGreaterThan(0)
  })

  it('is clamped, because a wing past the critical angle does not make more lift', () => {
    const { fwd, up } = axes(0, 0, 0)
    expect(Math.abs(angleOfAttack({ x: 0, y: -60, z: -1 }, fwd, up))).toBeLessThanOrEqual(0.42)
  })

  it('is zero standing still, where there is no airflow to be at an angle to', () => {
    const { fwd, up } = axes(0, 0.3, 0)
    expect(angleOfAttack({ x: 0, y: 0, z: 0 }, fwd, up)).toBe(0)
  })
})

describe('cameraFor', () => {
  it('puts the first-person eye AT the character and looks along the nose', () => {
    const s = startState({ x: 10, y: 1.7, z: 5 }, Math.PI / 2)
    const c = cameraFor('walk', s)
    expect(c.eye).toEqual(s.at)
    expect(c.look.x).toBeGreaterThan(s.at.x)
  })

  it('puts every other camera behind and above', () => {
    for (const kind of CRAFT_KINDS) {
      if (kind === 'walk') continue
      const s = startState({ x: 0, y: 100, z: 0 })
      const c = cameraFor(kind, s)
      expect(c.eye.y, kind).toBeGreaterThan(s.at.y)
      // behind, which with yaw 0 facing -z means +z
      expect(c.eye.z, kind).toBeGreaterThan(s.at.z)
    }
  })

  it('frames a jet from further away than a drone', () => {
    const s = startState({ x: 0, y: 100, z: 0 })
    const d = (k: CraftKind) => Math.hypot(cameraFor(k, s).eye.x - s.at.x, cameraFor(k, s).eye.z - s.at.z)
    expect(d('jet')).toBeGreaterThan(d('omnicopter'))
    expect(d('walk-third')).toBeLessThan(d('helicopter'))
  })
})
