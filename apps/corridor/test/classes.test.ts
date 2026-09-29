// Type and class are two questions, and collapsing them into one field is what emptied the fleet
// roster beside a library of 120 cars. These assert the separation rather than the lists.
import { describe, expect, it } from 'vitest'
import { CLASSES_BY_TYPE, KINDS, TYPES, typeOf } from '../src/classes'

describe('typeOf', () => {
  it('reads the type off the class when nothing says otherwise', () => {
    expect(typeOf({ kind: 'hero-car' })).toBe('vehicle')
    expect(typeOf({ kind: 'traffic' })).toBe('vehicle')
    expect(typeOf({ kind: 'pedestrian' })).toBe('actor')
    expect(typeOf({ kind: 'weapon' })).toBe('weapon')
    expect(typeOf({ kind: 'vegetation' })).toBe('prop')
  })

  it('lets a stored type win, so a vehicle with a class this build has never heard of stays one', () => {
    expect(typeOf({ type: 'vehicle', kind: 'hovercraft' })).toBe('vehicle')
    expect(typeOf({ type: 'vehicle', kind: 'vegetation' })).toBe('vehicle')
  })

  it('ignores a stored type that is not a type, rather than trusting the file', () => {
    expect(typeOf({ type: 'VEHICLE', kind: 'hero-car' })).toBe('vehicle')
    expect(typeOf({ type: 'spaceship', kind: 'pedestrian' })).toBe('actor')
  })

  it('calls an unknown or missing class a prop, which is the answer that breaks nothing', () => {
    // a prop places, draws and collides; the worst outcome is that nobody offers it a gearbox
    expect(typeOf({})).toBe('prop')
    expect(typeOf({ kind: '' })).toBe('prop')
    expect(typeOf({ kind: 'something-new' })).toBe('prop')
  })

  it('never asks about a mesh or a skeleton — an unrigged car is still a vehicle', () => {
    // Rich, 2026-09-29: "Unrigged cars should still be usable as vehicles, the wheels just won't
    // turn." Nothing in the signature can express a rig, which is the point.
    expect(typeOf({ kind: 'hero-car' })).toBe('vehicle')
  })
})

describe('the two vocabularies line up', () => {
  it('every class in the mapping is a real class', () => {
    for (const [t, ks] of Object.entries(CLASSES_BY_TYPE)) {
      for (const k of ks) expect(KINDS, `${k} (${t}) is in KINDS`).toContain(k)
    }
  })

  it('every class has exactly one type', () => {
    const seen = new Map()
    for (const [t, ks] of Object.entries(CLASSES_BY_TYPE)) {
      for (const k of ks) {
        expect(seen.has(k), `${k} is claimed by both ${seen.get(k)} and ${t}`).toBe(false)
        seen.set(k, t)
      }
    }
    // and none is left out: a class with no type would silently become a prop
    for (const k of KINDS) expect(seen.has(k), `${k} has no type`).toBe(true)
  })

  it('has a mapping for every type', () => {
    for (const t of TYPES) expect(Object.keys(CLASSES_BY_TYPE)).toContain(t)
  })
})
