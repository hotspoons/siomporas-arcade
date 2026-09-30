// Fixtures: the things the world draws by itself, and the variants a world may choose instead.
//
// Rich, 2026-09-30: *"make all of these built-in assets like light poles, power lines, stop
// signs, street sign components, start/finish lines, and checkpoint gates … fixtures with a few
// classes … we need to be able to add to and manage these types of assets, and use different
// variants in our levels … if there are any settings that we'd want per placed asset, put them in
// this new asset manager area."*
//
// THE SHAPE: a fixture CLASS is a thing the bake places (every stop sign, every signal mast, every
// power pole) or a race lays (every gate, every entry ring). Each class has a BUILT-IN — the
// procedural mesh the site has always drawn — and any catalog asset of that class is a VARIANT.
// A world says which it wears, per class, in `sites/<slug>/fixtures.json`, along with the
// class's settings; the viewer applies it (`FixtureLayer`), the asset manager edits it, and the
// MCP tools read and write it as a document. Positions are never in here: they are the bake's
// (`manifest.signals`, `manifest.power`) or the course's, so a variant never moves a sign.

import * as THREE from 'three'
import type { Manifest } from './site'
import type { Site } from './scene'
import { loadAssetGlb } from './carmodel'

export type FixtureClassId = 'race-gate' | 'race-marker' | 'stop-sign' | 'give-way-sign' | 'signal' | 'power-pole' | 'lamp-post' | 'street-sign' | 'missile-launcher' | 'machine-gun' | 'missile'

export interface FixtureSetting {
  key: string
  label: string
  kind: 'number' | 'colour' | 'bool'
  default: number | string | boolean
  min?: number
  max?: number
  step?: number
  note?: string
}

/** Where one fixture of a class stands: site metres, yaw counter-clockwise from east, degrees. */
export interface FixturePlace {
  x: number
  y: number
  z: number
  yaw_deg: number
  /** the bake's own height for it, when it has one (a tower), metres */
  height_m?: number
}

export interface FixtureClass {
  id: FixtureClassId
  label: string
  note: string
  /** what the world draws when no variant is chosen */
  builtin: string
  settings: FixtureSetting[]
  /** the procedural batches this class replaces, by mesh-name prefix in the site's layers */
  batches: string[]
  /** every instance the bake placed — null for the race fixtures, which the course places */
  places: ((m: Manifest) => FixturePlace[]) | null
  /** the height a model variant is fitted to, metres, unless the place carries its own */
  fitHeight: number
}

const num = (key: string, label: string, dflt: number, min: number, max: number, step: number, note?: string): FixtureSetting => ({ key, label, kind: 'number', default: dflt, min, max, step, note })
const colour = (key: string, label: string, dflt: string): FixtureSetting => ({ key, label, kind: 'colour', default: dflt })
const bool = (key: string, label: string, dflt: boolean, note?: string): FixtureSetting => ({ key, label, kind: 'bool', default: dflt, note })

type Signs = { masts?: { x: number; y: number; z: number; yaw_deg: number }[]; signs?: { kind: string; x: number; y: number; z: number; yaw_deg: number }[] }
type Power = { supports?: { kind: string; x: number; y: number; z: number; height_m?: number }[] }
const signals = (m: Manifest) => ((m as unknown as { signals?: Signs }).signals ?? {})
const power = (m: Manifest) => ((m as unknown as { power?: Power }).power ?? {})

export const FIXTURES: FixtureClass[] = [
  {
    id: 'race-gate', label: 'Race gate', note: 'start, finish, checkpoint and split lines',
    builtin: 'two posts and a banner, with a chequered stripe at a start or finish',
    settings: [
      num('height_m', 'Height (m)', 6, 2, 20, 0.5, 'of the posts and the banner'),
      colour('colour', 'Banner colour', '#4fc3f7'),
      bool('stripe', 'Chequered stripe at start and finish', true),
    ],
    batches: [], places: null, fitHeight: 6,
  },
  {
    id: 'race-marker', label: 'Race entry marker', note: 'the ring you drive into to commit to a race',
    builtin: 'a pulsing ring on the road and an arch standing over it, facing the start',
    settings: [
      bool('arch', 'Standing arch', true, 'a ring on the road alone is easy to miss'),
      colour('colour', 'Colour', '#ffd54f'),
    ],
    batches: [], places: null, fitHeight: 8,
  },
  /*
   * THE WEAPONS. Not placed by the bake — they ride on the player's car (weaponfx.ts mounts them
   * from the chassis spec) — but a class each, so the Fixtures tab can put a generated model in
   * the place of the built-in launcher, gun or missile. A bullet is a shader and has no class.
   */
  {
    id: 'missile-launcher', label: 'Missile launcher', note: 'on the roof of the player’s car; fires with RB / M',
    builtin: 'a twin-tube launcher on a rail', settings: [], batches: [], places: null, fitHeight: 0.4,
  },
  {
    id: 'machine-gun', label: 'Machine gun', note: 'one on each bonnet corner; hold LB / G',
    builtin: 'a receiver, a barrel and an ammunition can', settings: [], batches: [], places: null, fitHeight: 0.25,
  },
  {
    id: 'missile', label: 'Missile', note: 'the round the launcher fires',
    builtin: 'a finned body with a red nose and a flame', settings: [], batches: [], places: null, fitHeight: 0.3,
  },
  {
    id: 'stop-sign', label: 'Stop sign', note: 'every stop sign the bake found', builtin: 'an octagon on a post, painted',
    settings: [num('height_m', 'Height (m)', 2.4, 1.5, 4, 0.1)],
    batches: ['furniture:sign:stop'], fitHeight: 2.4,
    places: (m) => (signals(m).signs ?? []).filter((s) => s.kind === 'stop').map((s) => ({ x: s.x, y: s.y, z: s.z, yaw_deg: s.yaw_deg })),
  },
  {
    id: 'give-way-sign', label: 'Give way sign', note: 'every yield sign the bake found', builtin: 'a triangle on a post, painted',
    settings: [num('height_m', 'Height (m)', 2.4, 1.5, 4, 0.1)],
    batches: ['furniture:sign:give_way'], fitHeight: 2.4,
    places: (m) => (signals(m).signs ?? []).filter((s) => s.kind === 'give_way').map((s) => ({ x: s.x, y: s.y, z: s.z, yaw_deg: s.yaw_deg })),
  },
  {
    id: 'signal', label: 'Traffic signal', note: 'every signal mast at a junction', builtin: 'a mast with an arm and heads over each lane',
    settings: [num('height_m', 'Height (m)', 6, 3, 12, 0.25)],
    batches: ['furniture:signal:'], fitHeight: 6,
    places: (m) => (signals(m).masts ?? []).map((s) => ({ x: s.x, y: s.y, z: s.z, yaw_deg: s.yaw_deg })),
  },
  {
    id: 'power-pole', label: 'Power pole', note: 'every pole and pylon carrying the lines', builtin: 'a pole or a lattice tower at the bake’s own height',
    settings: [bool('keep_height', 'Keep the bake’s height', true, 'each support is as tall as the survey says; off scales every one to the model’s own')],
    batches: ['power:pole', 'power:tower'], fitHeight: 12,
    places: (m) => (power(m).supports ?? []).map((s) => ({ x: s.x, y: s.y, z: s.z, yaw_deg: 0, height_m: s.height_m })),
  },
  {
    id: 'lamp-post', label: 'Lamp post', note: 'street lighting', builtin: 'nothing yet — the bake carries no lamp posts',
    settings: [num('height_m', 'Height (m)', 8, 4, 14, 0.25)],
    batches: [], places: () => [], fitHeight: 8,
  },
  {
    id: 'street-sign', label: 'Street name sign', note: 'the blades on the corner posts', builtin: 'a blade with the road’s name on it',
    settings: [num('height_m', 'Height (m)', 2.6, 1.5, 4, 0.1)],
    batches: ['blades'], places: () => [], fitHeight: 2.6,
  },
]

export const FIXTURE_BY_ID: Record<string, FixtureClass> = Object.fromEntries(FIXTURES.map((f) => [f.id, f]))

/** What a world wears, per class. `asset` null or absent means the built-in. */
export interface FixtureChoice {
  asset?: string | null
  settings?: Record<string, number | string | boolean>
}

export interface FixtureDoc {
  version: 1
  choices: Partial<Record<FixtureClassId, FixtureChoice>>
}

export const EMPTY_FIXTURES: FixtureDoc = { version: 1, choices: {} }

/** A class's settings with the document's values over the defaults. */
export function settingsOf(doc: FixtureDoc | null, id: FixtureClassId): Record<string, number | string | boolean> {
  const cls = FIXTURE_BY_ID[id]
  const out: Record<string, number | string | boolean> = {}
  for (const s of cls.settings) out[s.key] = doc?.choices[id]?.settings?.[s.key] ?? s.default
  return out
}

export async function loadFixtures(slug: string, base = ''): Promise<FixtureDoc> {
  try {
    const r = await fetch(`${base}/sites/${slug}/fixtures.json`, { cache: 'no-cache' })
    if (!r.ok) return { version: 1, choices: {} }
    const text = (await r.text()).trimStart()
    if (!text.startsWith('{')) return { version: 1, choices: {} }
    const doc = JSON.parse(text) as FixtureDoc
    return { version: 1, choices: doc.choices ?? {} }
  } catch {
    return { version: 1, choices: {} }
  }
}

export async function saveFixtures(slug: string, doc: FixtureDoc): Promise<void> {
  const r = await fetch(`/sites/${slug}/fixtures.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc, null, 1) })
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!r.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${r.status}`)
}

/**
 * The variants a world wears, in the world.
 *
 * For every class with a chosen asset and places in the bake: the model, fitted to the class's
 * height (or the place's own), one clone per place, and the procedural batch it replaces hidden
 * by name. Choosing the built-in again brings the batch back. Race fixtures are not placed here —
 * the course places them — so `RaceWorld` asks this layer for its models instead.
 */
export class FixtureLayer {
  readonly group = new THREE.Group()
  private site: Site
  private doc: FixtureDoc = EMPTY_FIXTURES
  private hidden: THREE.Object3D[] = []
  private models = new Map<string, THREE.Object3D>()
  /** what could not be done, in words */
  problems: string[] = []
  /** instances placed per class, for a probe */
  placed: Partial<Record<FixtureClassId, number>> = {}

  constructor(site: Site) {
    this.site = site
    this.group.name = 'fixtures'
  }

  get document(): FixtureDoc {
    return this.doc
  }

  async apply(doc: FixtureDoc): Promise<void> {
    this.doc = { version: 1, choices: { ...doc.choices } }
    this.clear()
    for (const cls of FIXTURES) {
      const choice = this.doc.choices[cls.id]
      if (!choice?.asset || !cls.places) continue
      const places = cls.places(this.site.manifest)
      if (!places.length) continue
      const settings = settingsOf(this.doc, cls.id)
      const height = typeof settings.height_m === 'number' ? settings.height_m : cls.fitHeight
      const model = await this.model(choice.asset, height)
      if (!model) { this.problems.push(`${cls.label}: "${choice.asset}" has no usable model — the built-in stays`); continue }
      const box = new THREE.Box3().setFromObject(model)
      const modelH = box.max.y - box.min.y || 1
      let n = 0
      for (const p of places) {
        const inst = model.clone(true)
        const wantH = cls.id === 'power-pole' && settings.keep_height !== false && p.height_m ? p.height_m : height
        if (Math.abs(wantH - modelH) > 1e-3) inst.scale.setScalar(wantH / modelH)
        // site x east, y north, z up → three x east, y up, z south; a yaw counter-clockwise from
        // east is a rotation about +Y (which takes +X toward −Z, north) of the same angle
        const ground = this.site.groundAt(p.x, -p.y) ?? p.z
        inst.position.set(p.x, ground, -p.y)
        inst.rotation.set(0, (p.yaw_deg * Math.PI) / 180, 0)
        this.group.add(inst)
        n++
      }
      this.placed[cls.id] = n
      this.hide(cls)
    }
  }

  /** The chosen model for a race fixture, if any, fitted to the class's height. */
  async raceModel(id: 'race-gate' | 'race-marker'): Promise<THREE.Object3D | null> {
    return this.fixtureModel(id)
  }

  /** The chosen model for any class the bake does not place itself (the races, the weapons): null means the built-in. */
  async fixtureModel(id: FixtureClassId): Promise<THREE.Object3D | null> {
    const choice = this.doc.choices[id]
    if (!choice?.asset) return null
    const settings = settingsOf(this.doc, id)
    const h = typeof settings.height_m === 'number' ? settings.height_m : FIXTURE_BY_ID[id].fitHeight
    return this.model(choice.asset, h)
  }

  private async model(assetId: string, height: number): Promise<THREE.Object3D | null> {
    const key = `${assetId}@${height}`
    const had = this.models.get(key)
    if (had) return had
    const m = await loadAssetGlb(assetId, height)
    if (m) this.models.set(key, m)
    return m
  }

  private hide(cls: FixtureClass): void {
    const roots = [this.site.layers.furniture, this.site.layers.power, this.site.layers.blades].filter(Boolean) as THREE.Object3D[]
    for (const root of roots) {
      root.traverse((o) => {
        if (o === root || !o.visible) return
        if (cls.batches.some((b) => o.name.startsWith(b))) { o.visible = false; this.hidden.push(o) }
      })
    }
  }

  private clear(): void {
    for (const o of this.hidden) o.visible = true
    this.hidden = []
    for (const c of [...this.group.children]) this.group.remove(c)
    this.placed = {}
    this.problems = []
  }

  dispose(): void {
    this.clear()
    this.group.removeFromParent()
  }
}
