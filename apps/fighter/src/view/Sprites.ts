// The art, and which frame of it a fighter is wearing right now.
//
// Art is optional. Everything here returns null when the atlas for a character or a stage is not
// there, and the renderer falls back to drawing boxes — so the game runs with no art at all, with
// art for one character, or with a stage and no fighters. The files are produced by
// `scripts/sf2-rip.mjs` into `public/assets/crown/` and their shape is the contract that script
// writes to: frames with an atlas rect and an anchor, animations as lists of frame names.
//
// THE ANCHOR is the whole trick. Every frame is trimmed to its own bounding box, so a sweep is wide
// and short and an uppercut is tall and narrow; `ax, ay` is where the fighter's feet are inside
// that box, and the renderer puts *that* point at the fighter's world position. Without it the
// character jitters around the screen as the animation plays.
//
// Paths are root-relative on purpose: in the arcade this game is served at /crown, where a bare
// `assets/…` would resolve against whatever menu the URL happens to be on.

import type { Fighter } from '../sim/Fighter'
import { activeOn, totalFrames } from '../sim/Moves'
import { SYSTEM } from '../sim/Character'

export const ASSET_ROOT = '/assets/crown'

export interface FrameRect {
  x: number
  y: number
  w: number
  h: number
  ax: number
  ay: number
}

export interface Anim {
  frames: string[]
  fps: number
  loop?: boolean
  pingpong?: boolean
}

interface FramesJson {
  id: string
  atlas: string
  pixelScale?: number
  frames: Record<string, FrameRect>
  anims: Record<string, Anim>
  missing?: string[]
}

export interface CharacterArt {
  id: string
  image: HTMLImageElement
  portrait: HTMLImageElement | null
  frames: Record<string, FrameRect>
  anims: Record<string, Anim>
}

export interface StageLayer {
  name: string
  image: HTMLImageElement
  w: number
  h: number
  parallax: number
  /** Bottom edge, world pixels relative to the floor line. Negative is up. */
  y: number
  repeat: boolean
  /** Horizontal offset of the layer's centre from the stage's centre. */
  x: number
}

export interface StageArt {
  id: string
  sky: string | null
  layers: StageLayer[]
}

export interface FxArt {
  image: HTMLImageElement
  frames: Record<string, FrameRect>
  anims: Record<string, Anim>
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

async function loadJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

// One fetch per character for the life of the page. The select screen wants every atlas at once and
// the fight wants two of them; without this, walking the roster with the switch keys re-downloads a
// character every time you pass them.
const pending = new Map<string, Promise<CharacterArt | null>>()
const settled = new Map<string, CharacterArt | null>()

export function loadCharacterArt(art: string): Promise<CharacterArt | null> {
  let p = pending.get(art)
  if (!p) {
    p = fetchCharacterArt(art).then((a) => {
      settled.set(art, a)
      return a
    })
    pending.set(art, p)
  }
  return p
}

/** What has already arrived, for a caller that must draw this frame and cannot await. */
export function cachedArt(art: string): CharacterArt | null {
  return settled.get(art) ?? null
}

async function fetchCharacterArt(art: string): Promise<CharacterArt | null> {
  const dir = `${ASSET_ROOT}/chars/${art}`
  const j = await loadJson<FramesJson>(`${dir}/frames.json`)
  if (!j) return null
  const [image, portrait] = await Promise.all([loadImage(`${dir}/${j.atlas}`), loadImage(`${dir}/portrait.png`)])
  if (!image) return null
  return { id: j.id, image, portrait, frames: j.frames, anims: j.anims }
}

interface StageJson {
  id: string
  sky?: string
  layers: Array<{ name: string; file: string; w?: number; h?: number; parallax: number; y: number; repeat?: boolean; x?: number }>
  props?: Array<{ name: string; file: string; w?: number; h?: number; x: number; y: number; parallax?: number }>
}

export async function loadStageArt(id: string): Promise<StageArt | null> {
  const dir = `${ASSET_ROOT}/stages/${id}`
  const j = await loadJson<StageJson>(`${dir}/stage.json`)
  if (!j) return null
  const layers: StageLayer[] = []
  const wanted = [
    ...j.layers.map((l) => ({ ...l, x: l.x ?? 0, repeat: l.repeat ?? false })),
    // Props are just small layers that sit somewhere in particular.
    ...(j.props ?? []).map((p) => ({ name: p.name, file: p.file, w: p.w, h: p.h, parallax: p.parallax ?? 1, y: p.y, repeat: false, x: p.x })),
  ]
  const images = await Promise.all(wanted.map((l) => loadImage(`${dir}/${l.file}`)))
  wanted.forEach((l, i) => {
    const image = images[i]
    if (!image) return
    layers.push({ name: l.name, image, w: l.w ?? image.naturalWidth, h: l.h ?? image.naturalHeight, parallax: l.parallax, y: l.y, repeat: l.repeat, x: l.x })
  })
  // Back to front. Ties keep file order, so a prop listed after the floor draws over it.
  layers.sort((a, b) => a.parallax - b.parallax)
  return { id: j.id, sky: j.sky ?? null, layers }
}

export async function loadFxArt(): Promise<FxArt | null> {
  const dir = `${ASSET_ROOT}/fx`
  const j = await loadJson<{ atlas: string; frames: Record<string, FrameRect>; anims: Record<string, Anim> }>(`${dir}/sparks.json`)
  if (!j) return null
  const image = await loadImage(`${dir}/${j.atlas}`)
  if (!image) return null
  return { image, frames: j.frames, anims: j.anims }
}

// --- which frame -----------------------------------------------------------------------------

/** First animation of the list that the art actually has. */
function anim(art: CharacterArt, ...names: string[]): Anim | null {
  for (const n of names) {
    const a = art.anims[n]
    if (a && a.frames.length > 0) return a
  }
  return null
}

/** Frame `i` of `a`, clamped or looped as the animation says. */
function at(art: CharacterArt, a: Anim, i: number, loop = a.loop ?? true): FrameRect | null {
  const n = a.frames.length
  let k: number
  if (a.pingpong && n > 1) {
    const cycle = 2 * n - 2
    const m = loop ? i % cycle : Math.min(i, cycle)
    k = m < n ? m : cycle - m
  } else {
    k = loop ? i % n : Math.min(i, n - 1)
  }
  return art.frames[a.frames[Math.max(0, k)]] ?? null
}

/** `frames` elapsed at the animation's own rate. */
const step = (a: Anim, frames: number): number => Math.floor((frames * a.fps) / 60)

/**
 * A move's animation laid over its frame data: the frames before the peak are spread over startup,
 * the peak is held for every active frame, and whatever is left plays out over recovery. So the
 * extended fist is on screen exactly while the hitbox is, whatever the sheet's frame count.
 */
function attackFrame(art: CharacterArt, a: Anim, f: Fighter): FrameRect | null {
  const m = f.action
  if (!m) return null
  const n = a.frames.length
  const total = totalFrames(m)
  const begin = m.startup - 1
  const fr = f.actionFrame

  if (m.untilLand || (m.rise && n > 2)) {
    // Air normals and rising specials: walk the animation over the whole move at its own rate,
    // holding the last frame.
    return at(art, a, step(a, fr), false)
  }

  // Multi-hit and travelling specials loop while live, so a roll keeps rolling.
  if (m.hits > 1 || m.travel) {
    if (activeOn(m, fr) || fr < begin) return at(art, a, step(a, fr), true)
    return at(art, a, n - 1, false)
  }

  // Where the extension is: the last frame for two- or three-frame anims, ~60% of the way through
  // longer ones that include the retraction.
  const peak = a.pingpong ? n - 1 : n <= 3 ? n - 1 : Math.round((n - 1) * 0.6)
  if (fr < begin) {
    const t = begin <= 0 ? 1 : fr / begin
    return at(art, a, Math.min(peak, Math.floor(t * (peak + 1))), false)
  }
  if (activeOn(m, fr)) return at(art, a, peak, false)
  // Recovery: from the peak to the end (or back to the start on a pingpong).
  const rec = Math.max(1, total - begin - m.active)
  const t = Math.min(1, (fr - begin - m.active) / rec)
  if (a.pingpong) return at(art, a, peak + Math.floor(t * (n - 1)), true)
  const tail = n - 1 - peak
  return at(art, a, peak + Math.floor(t * tail), false)
}

export interface Pose {
  frame: FrameRect
  /** Draw mirrored: the sheet faces right, the fighter faces left. */
  flip: boolean
}

/** What this fighter looks like right now. Null if the art has nothing usable for the state. */
export function poseOf(f: Fighter, art: CharacterArt): Pose | null {
  const flip = f.facing < 0
  const pick = (fr: FrameRect | null): Pose | null => (fr ? { frame: fr, flip } : null)
  const sf = f.stateFrame

  switch (f.state) {
    case 'idle': {
      const a = anim(art, 'idle')
      return a ? pick(at(art, a, step(a, sf))) : null
    }
    case 'walk-fwd': {
      const a = anim(art, 'walk-fwd', 'idle')
      return a ? pick(at(art, a, step(a, sf))) : null
    }
    case 'walk-back': {
      const a = anim(art, 'walk-back', 'walk-fwd', 'idle')
      if (!a) return null
      // A back walk that is only a forward walk plays in reverse.
      const i = art.anims['walk-back'] ? step(a, sf) : a.frames.length * 1000 - step(a, sf)
      return pick(at(art, a, i))
    }
    case 'crouch': {
      const a = anim(art, 'crouch', 'crouch-idle')
      return a ? pick(at(art, a, step(a, sf), false)) : null
    }
    case 'jumpsquat': {
      const a = anim(art, 'jump-neutral', 'crouch')
      return a ? pick(at(art, a, 0, false)) : null
    }
    case 'air': {
      const a = anim(art, f.jumpDir === 0 ? 'jump-neutral' : 'jump-fwd', 'jump-neutral', 'jump-fwd', 'idle')
      if (!a) return null
      // Rising through the first half of the frames, falling through the second.
      const vy0 = f.character.jumpVy
      const t = Math.max(0, Math.min(0.999, (vy0 - f.vy) / (2 * vy0)))
      return pick(at(art, a, Math.floor(t * a.frames.length), false))
    }
    case 'land': {
      const a = anim(art, 'land', 'crouch', 'idle')
      return a ? pick(at(art, a, a.frames.length - 1, false)) : null
    }
    case 'attack': {
      const m = f.action
      if (!m) return null
      const a = anim(art, m.anim, m.id, m.stance === 'air' ? 'air-hk' : m.stance === 'crouch' ? 'crouch-hp' : 'stand-hp', 'idle')
      return a ? pick(attackFrame(art, a, f)) : null
    }
    case 'hitstun': {
      const airborne = f.y > 0
      const name = airborne ? 'hit-air' : f.stance === 'crouch' ? 'hit-crouch' : f.lastHit.height === 'low' ? 'hit-low' : 'hit-high'
      const a = anim(art, airborne && f.health <= 0 ? 'ko' : name, 'knockdown', 'hit-high', 'idle')
      if (!a) return null
      // A body in the air after a knockdown tumbles through the knockdown frames as it falls.
      if (airborne && art.anims.knockdown && (f.vy < 0 || f.health <= 0)) {
        const kd = art.anims.knockdown
        return pick(at(art, kd, Math.min(kd.frames.length - 2, step(kd, sf)), false))
      }
      return pick(at(art, a, Math.min(a.frames.length - 1, Math.floor(sf / 4)), false))
    }
    case 'blockstun': {
      const a = anim(art, f.guardLow ? 'block-crouch' : 'block-stand', 'block-stand', 'crouch', 'idle')
      return a ? pick(at(art, a, step(a, sf), false)) : null
    }
    case 'thrown': {
      const a = anim(art, 'thrown', 'hit-air', 'knockdown', 'idle')
      return a ? pick(at(art, a, Math.floor(sf / 6), false)) : null
    }
    case 'down': {
      const d = anim(art, 'down', 'knockdown')
      const g = anim(art, 'getup')
      if (!d) return null
      const getupFrames = g ? g.frames.length * 4 : 0
      const total = f.stateFrame
      const left = SYSTEM.knockdownFrames - total
      if (g && left <= getupFrames) return pick(at(art, g, Math.floor((getupFrames - left) / 4), false))
      return pick(at(art, d, d.frames.length - 1, false))
    }
    case 'dizzy': {
      const a = anim(art, 'dizzy', 'hit-high', 'idle')
      return a ? pick(at(art, a, step(a, sf))) : null
    }
    case 'ko': {
      const a = anim(art, 'down', 'knockdown', 'ko')
      return a ? pick(at(art, a, a.frames.length - 1, false)) : null
    }
    case 'win': {
      const a = anim(art, 'win', 'idle')
      return a ? pick(at(art, a, step(a, sf), (a.loop ?? true) && a.frames.length > 4)) : null
    }
  }
}

/** Frame of a looping effect animation at `age` frames old, or null when it has finished. */
export function fxFrame(fx: FxArt, name: string, age: number, fallback?: string): FrameRect | null {
  const a = fx.anims[name] ?? (fallback ? fx.anims[fallback] : undefined)
  if (!a || a.frames.length === 0) return null
  const i = step(a, age)
  if (i >= a.frames.length) return null
  return fx.frames[a.frames[i]] ?? null
}
