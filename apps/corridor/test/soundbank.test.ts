// The sound bank's arithmetic, with no AudioContext in sight: which clip a slot resolves to under
// a document's overrides, that a slot never repeats itself, how the squeal crossfades, how a
// crash is graded, and what the validator refuses.

import { describe, expect, it } from 'vitest'
import { crashSlot, SLOT_HELP, SOUND_SLOTS, SoundBank, squealMix, validateSoundOverrides, type BankManifest } from '../src/game/audio/soundbank'
import bankJson from '../public/sounds/bank.json'

const manifest: BankManifest = {
  version: 1,
  formats: ['ogg', 'mp3'],
  slots: {
    'gun.fire': { desc: 'a round', clips: [{ file: 'gun-fire/a.ogg', s: 0.4 }, { file: 'gun-fire/b.ogg', s: 0.4 }, { file: 'gun-fire/c.ogg', s: 0.4 }] },
    'gun.fire.shotgun': { desc: 'a blast', clips: [{ file: 'gun-fire-shotgun/s.ogg', s: 0.8 }] },
    'tire.squeal.loop': { desc: 'squeal', loop: true, ordered: true, clips: [{ file: 'tire-squeal-loop/l.ogg', s: 2.5 }, { file: 'tire-squeal-loop/h.ogg', s: 2.5 }] },
    'crash.heavy': { desc: 'a wreck', clips: [{ file: 'crash-heavy/slam-1.ogg', s: 1 }] },
  },
}
const bank = () => new SoundBank(manifest, { ext: 'ogg', assetUrl: (id, f) => `/assetsvc/catalog/${id}/file/sounds/${f}` })

describe('the shipped bank', () => {
  it('has every slot the game plays, each with at least one clip', () => {
    const b = bankJson as BankManifest
    for (const slot of SOUND_SLOTS) {
      expect(b.slots[slot], slot).toBeDefined()
      expect(b.slots[slot].clips.length, slot).toBeGreaterThan(0)
      for (const c of b.slots[slot].clips) expect(c.file, `${slot} ${c.file}`).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9_.-]+\.ogg$/)
    }
    expect(b.slots['tire.squeal.loop'].loop).toBe(true)
    expect(b.slots['tire.squeal.loop'].ordered).toBe(true)
    expect(b.slots['tire.squeal.loop'].clips.length).toBe(3)
  })
  it('describes every slot', () => {
    for (const slot of SOUND_SLOTS) expect(SLOT_HELP[slot].length).toBeGreaterThan(10)
  })
})

describe('resolving a slot', () => {
  it('falls through to the bank, in the browser’s format', () => {
    const b = bank()
    expect(b.resolve('gun.fire').map((c) => c.url)).toEqual(['/sounds/gun-fire/a.ogg', '/sounds/gun-fire/b.ogg', '/sounds/gun-fire/c.ogg'])
    expect(new SoundBank(manifest, { ext: 'mp3' }).resolve('gun.fire')[0].url).toBe('/sounds/gun-fire/a.mp3')
    expect(b.resolve('tire.squeal.loop').every((c) => c.loop)).toBe(true)
    expect(b.resolve('nothing.here')).toEqual([])
  })
  it('the nearest scope that mentions the slot wins, even with nothing in it', () => {
    const b = bank()
    const car = { 'gun.fire': ['slot:gun.fire.shotgun'] }
    const world = { 'gun.fire': ['crash-heavy/slam-1'], 'crash.heavy': [] as string[] }
    expect(b.resolve('gun.fire', [car, world]).map((c) => c.url)).toEqual(['/sounds/gun-fire-shotgun/s.ogg'])
    expect(b.resolve('gun.fire', [null, world]).map((c) => c.url)).toEqual(['/sounds/crash-heavy/slam-1.ogg'])
    expect(b.resolve('crash.heavy', [car, world])).toEqual([])
    expect(b.pick('crash.heavy', [car, world])).toBeNull()
  })
  it('reads every entry form', () => {
    const b = bank()
    const sc = { 'gun.fire': ['gun-fire/b', 'gun-fire/c.ogg', 'asset:kestrel/bang.wav', 'https://x.test/y.mp3', '/sounds/z.ogg', 'asset:broken'] }
    expect(b.resolve('gun.fire', [sc]).map((c) => c.url)).toEqual([
      '/sounds/gun-fire/b.ogg', '/sounds/gun-fire/c.ogg', '/assetsvc/catalog/kestrel/file/sounds/bang.wav', 'https://x.test/y.mp3', '/sounds/z.ogg',
    ])
    // a bank clip keeps its length from the manifest; a foreign one does not know it
    expect(b.resolve('gun.fire', [sc])[0].s).toBe(0.4)
    expect(b.resolve('gun.fire', [sc])[2].s).toBe(0)
  })
  it('a slot pointing at itself ends', () => {
    expect(bank().resolve('gun.fire', [{ 'gun.fire': ['slot:gun.fire'] }])).toEqual([])
  })
  it('never picks the same clip twice running, per slot', () => {
    const b = bank()
    let prev = b.pick('gun.fire')!.url
    for (let i = 0; i < 200; i++) {
      const c = b.pick('gun.fire')!.url
      expect(c).not.toBe(prev)
      prev = c
    }
    // a single-clip slot has no choice
    expect(b.pick('gun.fire.shotgun')!.url).toBe(b.pick('gun.fire.shotgun')!.url)
  })
  it('lists the bank’s entries for the editor without their extension', () => {
    expect(bank().bankEntries('gun.fire')).toEqual(['gun-fire/a', 'gun-fire/b', 'gun-fire/c'])
    expect(bank().slots().find((s) => s.slot === 'tire.squeal.loop')).toMatchObject({ clips: 2, loop: true })
  })
})

describe('the squeal mix', () => {
  it('is silent at zero, opens by a quarter, and crossfades light to heavy', () => {
    expect(squealMix(0, 3).gains).toEqual([0, 0, 0])
    const q = squealMix(0.25, 3).gains
    expect(q[0]).toBeCloseTo(0.5, 5)
    const mid = squealMix(0.5, 3).gains
    expect(mid[1]).toBeCloseTo(1, 5)
    expect(mid[0]).toBeCloseTo(0, 5)
    expect(mid[2]).toBeCloseTo(0, 5)
    const top = squealMix(1, 3).gains
    expect(top).toEqual([0, 0, 1])
    // between levels the two neighbours sum to the opening
    const g = squealMix(0.7, 3).gains
    expect(g[1] + g[2]).toBeCloseTo(1, 5)
    expect(g[0]).toBe(0)
  })
  it('copes with one level and none, and clamps rubbish', () => {
    expect(squealMix(0.6, 1).gains).toEqual([1])
    expect(squealMix(0.6, 0).gains).toEqual([])
    expect(squealMix(NaN, 3).gains).toEqual([0, 0, 0])
    expect(squealMix(7, 2).gains).toEqual([0, 1])
    expect(squealMix(1, 3).rate).toBeCloseTo(1.05, 5)
  })
})

describe('grading a crash', () => {
  it('nothing, a tap, a hit, a wreck, glass', () => {
    expect(crashSlot(100, 1200, 6000)).toBeNull()
    expect(crashSlot(NaN, 1200, 6000)).toBeNull()
    expect(crashSlot(600, 1200, 6000)).toMatchObject({ slot: 'crash.light', glass: false })
    expect(crashSlot(3000, 1200, 6000)).toMatchObject({ slot: 'crash.medium', glass: false })
    expect(crashSlot(7000, 1200, 6000)).toMatchObject({ slot: 'crash.heavy', glass: false })
    expect(crashSlot(12000, 1200, 6000)).toMatchObject({ slot: 'crash.heavy', glass: true })
    expect(crashSlot(1199, 1200, 6000)!.gain).toBeLessThanOrEqual(1)
  })
})

describe('validating overrides', () => {
  it('accepts a good record and nothing at all', () => {
    expect(validateSoundOverrides(undefined)).toEqual([])
    expect(validateSoundOverrides({ 'gun.fire': ['gun-fire/a', 'slot:gun.fire.shotgun'], 'crash.heavy': [] })).toEqual([])
  })
  it('names the slot it does not know and the entry that is not a clip', () => {
    const errs = validateSoundOverrides({ 'horn': ['x'], 'gun.fire': [3, ''] })
    expect(errs.some((e) => e.includes('sounds.horn is not a sound slot'))).toBe(true)
    expect(errs.filter((e) => e.startsWith('sounds.gun.fire[')).length).toBe(2)
    expect(validateSoundOverrides([])).toEqual(['sounds must be an object of slot → clips'])
    expect(validateSoundOverrides({ 'gun.fire': 'gun-fire/a' })).toEqual(['sounds.gun.fire must be a list of clips'])
  })
})
