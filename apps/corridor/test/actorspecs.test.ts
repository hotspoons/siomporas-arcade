// The actor document: does the arithmetic mean anything, and does a ragdoll built from one weigh
// what the document said?
//
// Same shape as `vehicles.test.ts` and for the same reason. The assertions that matter are the ones
// with a negative twin — a walk faster than a run is an error AND the right way round is not; a
// ragdoll built from an 86 kg document weighs 86 kg AND one built from a 22 kg document does not.

import { beforeAll, describe, expect, it } from 'vitest'
import { KINDS } from '../src/assets/classes'
import { loadRapier, rapier } from '@apex/engine/physics/rapier'
import { Ragdoll } from '@apex/engine/physics/ragdoll'
import { PhysicsWorld } from '@apex/engine/physics/world'
import {
  ACTOR_CLASSES, ACTOR_TEMPLATE_IDS, damageAfterArmour, defaultActor, describeActor, dps, hitsToKill, jumpDistance,
  jumpHeight, toRagdollLimbs, toSpawnOpts, validateActor, type ActorDoc,
} from '../src/game/actors/actorspecs'

beforeAll(async () => {
  await loadRapier()
})

describe('the defaults', () => {
  it('has a document per class and every one validates clean', () => {
    expect(ACTOR_TEMPLATE_IDS.length).toBeGreaterThan(3)
    for (const kind of ACTOR_TEMPLATE_IDS) {
      const r = validateActor(defaultActor(kind))
      expect(r.errors, `${kind} errors`).toEqual([])
      expect(r.warnings, `${kind} warnings`).toEqual([])
    }
  })

  it('hands back a copy', () => {
    const a = defaultActor('character')
    a.combat.weapons.push('pistol-9mm')
    expect(defaultActor('character').combat.weapons).toEqual([])
  })

  it('makes a bird fly and a pedestrian not', () => {
    expect(defaultActor('bird').move.fly_ms).toBeGreaterThan(0)
    expect(defaultActor('pedestrian').move.fly_ms).toBe(0)
    expect(defaultActor('character').move.climb_ms).toBeGreaterThan(0)
  })
})

describe('validation', () => {
  const clean = () => defaultActor('character')

  it('catches walk and run filled in the wrong way round', () => {
    const a = clean()
    expect(validateActor(a).errors).toEqual([])
    a.move.walk_ms = 5.2
    a.move.run_ms = 1.6
    expect(validateActor(a).errors.join(' ')).toMatch(/wrong way round/)
  })

  it('catches a mass and a height that cannot both be right', () => {
    const a = clean()
    a.body.mass = 7800 // somebody typed the vehicle's number
    expect(validateActor(a).warnings.join(' ')).toMatch(/denser than stone/)
    a.body.mass = 0.5
    expect(validateActor(a).warnings.join(' ')).toMatch(/lighter than air/)
    // the negative twin: a real person must produce neither
    a.body.mass = 78
    expect(validateActor(a).warnings.join(' ')).not.toMatch(/denser|lighter/)
  })

  it('refuses a weapon that is not in the library, and accepts one that is', () => {
    const a = clean()
    a.combat.weapons = ['pistol-9mm', 'raygun']
    const r = validateActor(a, { weapons: ['pistol-9mm', 'crowbar'] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/no weapon asset "raygun"/)
    expect(r.errors.join(' ')).not.toMatch(/pistol/)
    // and with no list to check against, nothing is refused — the editor may not have one yet
    expect(validateActor(a).ok).toBe(true)
  })

  it('refuses armour outside 0…1 and warns at exactly 1', () => {
    const a = clean()
    a.body.armour = 1.4
    expect(validateActor(a).errors.join(' ')).toMatch(/armour must be between 0 and 1/)
    a.body.armour = 1
    expect(validateActor(a).ok).toBe(true)
    expect(validateActor(a).warnings.join(' ')).toMatch(/nothing can ever hurt this/)
  })

  it('says so when a rigged actor has no rig binding', () => {
    const a = clean()
    expect(validateActor(a, { rigRoles: ['hand_r'] }).warnings.join(' ')).not.toMatch(/no rig binding/)
    expect(validateActor(a, { rigRoles: [] }).warnings.join(' ')).toMatch(/weapons will not attach/)
  })

  it('reports every problem at once', () => {
    const a = clean()
    a.body.health = 0
    a.body.armour = 5
    a.move.run_ms = -1
    a.combat.attack_s = 0
    expect(validateActor(a).errors.length).toBeGreaterThanOrEqual(4)
  })
})

describe('the arithmetic', () => {
  it('turns a jump velocity into a height and a distance somebody can design against', () => {
    const a = defaultActor('character') // 4.0 m/s up, 5.2 m/s run
    expect(jumpHeight(a)).toBeCloseTo((4.0 * 4.0) / (2 * 9.81), 6)
    expect(jumpHeight(a)).toBeGreaterThan(0.75) // a ledge somebody can reach
    expect(jumpHeight(a)).toBeLessThan(1.0)
    expect(jumpDistance(a)).toBeCloseTo((2 * 5.2 * 4.0) / 9.81, 6)
  })

  it('makes armour refuse a share rather than subtract, so small hits are not free', () => {
    const a = defaultActor('character')
    a.body.armour = 0.5
    expect(damageAfterArmour(10, a)).toBe(5)
    expect(damageAfterArmour(1, a)).toBe(0.5) // a subtraction would make this 0
    a.body.armour = 0
    expect(damageAfterArmour(10, a)).toBe(10)
  })

  it('counts hits to kill, and says infinite rather than dividing by zero', () => {
    const attacker = defaultActor('hostile') // 18 damage, 0.9 s
    const target = defaultActor('pedestrian') // 100 hp, no armour
    const { hits, seconds } = hitsToKill(attacker, target)
    expect(hits).toBe(Math.ceil(100 / 18))
    expect(seconds).toBeCloseTo((hits - 1) * 0.9, 6)

    const armoured = defaultActor('pedestrian')
    armoured.body.armour = 1
    expect(hitsToKill(attacker, armoured).hits).toBe(Infinity)
  })

  it('makes a hostile out-damage a pedestrian', () => {
    expect(dps(defaultActor('hostile'))).toBeGreaterThan(dps(defaultActor('pedestrian')))
  })

  it('clamps health into what the ECS can actually hold', () => {
    // Health.hp is a Uint16Array. A 70,000 hp boss silently becoming 4,464 is the kind of quiet
    // nothing this repo keeps finding, so it is clamped where the two meet.
    const a = defaultActor('character')
    a.body.health = 70000
    expect(toSpawnOpts(a).health).toBe(65535)
    a.body.health = 0.4
    expect(toSpawnOpts(a).health).toBe(1)
    a.body.health = 250
    expect(toSpawnOpts(a).health).toBe(250)
  })

  it('hands the ECS the WALKING speed, not the running one', () => {
    const a = defaultActor('pedestrian')
    expect(toSpawnOpts(a).speed).toBe(a.move.walk_ms)
  })
})

describe('a ragdoll built from a document', () => {
  function world() {
    const R = rapier()
    const phys = new PhysicsWorld({ hz: 120 })
    const gb = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -1, 0))
    const gd = R.ColliderDesc.cuboid(200, 1, 200).setFriction(1)
    phys.describe(gd, 'terrain', { events: false })
    phys.world.createCollider(gd, gb)
    return phys
  }

  it('weighs what the document said, whatever the document said', () => {
    for (const kind of ['pedestrian', 'hostile', 'dog']) {
      const a = defaultActor(kind)
      const phys = world()
      const rd = Ragdoll.from(phys, toRagdollLimbs(a, { x: 0, y: 0, z: 0 }))
      expect(rd.mass, `${kind} mass`).toBeCloseTo(a.body.mass, 1)
      phys.free()
    }
  })

  it('scales with height, so a child is not a small adult standing in a hole', () => {
    const tall = defaultActor('character')
    const short = defaultActor('character')
    tall.body.height = 2.0
    short.body.height = 1.2
    const head = (a: ActorDoc) => toRagdollLimbs(a, { x: 0, y: 0, z: 0 }).find((l) => l.name === 'head')!
    expect(head(tall).from.y).toBeGreaterThan(head(short).from.y)
    expect(head(tall).radius).toBeGreaterThan(head(short).radius)
  })

  it('falls over and stays in one piece', () => {
    const a = defaultActor('hostile')
    const phys = world()
    const rd = Ragdoll.from(phys, toRagdollLimbs(a, { x: 0, y: 0, z: 0 }))
    const head = rd.get('head')!
    expect(head.body.translation().y).toBeGreaterThan(a.body.height * 0.75)
    for (let t = 0; t < 8; t += 1 / 60) phys.step(1 / 60)
    expect(head.body.translation().y).toBeLessThan(0.7)
    const p = rd.get('pelvis')!.body.translation()
    for (const l of rd.limbs) {
      const q = l.body.translation()
      expect(Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z), `${l.name} attached`).toBeLessThan(1.8)
    }
    phys.free()
  })

  it('is thrown further by the same shove when it is lighter', () => {
    const shove = (kind: string) => {
      const a = defaultActor(kind)
      const phys = world()
      const rd = Ragdoll.from(phys, toRagdollLimbs(a, { x: 0, y: 0, z: 0 }))
      for (let t = 0; t < 0.4; t += 1 / 60) phys.step(1 / 60)
      const x0 = rd.get('pelvis')!.body.translation().x
      rd.shove(900, 300, 0)
      for (let t = 0; t < 1.2; t += 1 / 60) phys.step(1 / 60)
      const d = rd.get('pelvis')!.body.translation().x - x0
      phys.free()
      return d
    }
    // 22 kg dog vs 86 kg hostile, same impulse: the light one goes further. This is also the check
    // that `toRagdollLimbs` scaled the masses at all rather than building a 72 kg person every time.
    expect(shove('dog')).toBeGreaterThan(shove('hostile'))
  })
})

describe('the summary line', () => {
  it('says what the thing can do', () => {
    expect(describeActor(defaultActor('bird'))).toMatch(/flying/)
    expect(describeActor(defaultActor('character'))).toMatch(/climbs/)
    expect(describeActor(defaultActor('bird'))).toMatch(/no ragdoll/)
    expect(describeActor(defaultActor('pedestrian'))).toMatch(/hp/)
  })
})

describe('the class vocabulary', () => {
  it('names classes the asset library has, or says why not', () => {
    for (const k of ACTOR_CLASSES) {
      // `character` is not in the library's standard list yet; it is accepted because the library
      // merges in whatever classes are already in use. Everything else must be a real word.
      if (k === 'character') continue
      expect(KINDS, `${k} is a real class`).toContain(k)
    }
    for (const k of ACTOR_CLASSES) expect(validateActor(defaultActor(k)).errors, k).toEqual([])
    for (const k of ['furniture', 'prop', 'hero-car']) expect(ACTOR_CLASSES).not.toContain(k)
  })
})
