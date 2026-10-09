// The sound bank: WHICH clip plays for WHAT, with nothing that needs a browser in it.
//
// Rich, 2026-10-09: "find us a free sound bank … different levels of tire squeal based on turning
// force, crash and collision noises (a random set of noises that is picked from), explosion noises
// for missile, missile launching noises, gun firing noises, gun hitting noises. And make sure this
// sound bank is featured in the level editor with the ability to provide custom sounds for any
// vehicle, actor, etc. and feature it in the code editor."
//
// So there are three layers, and this file is the join between them:
//
//   1. THE BANK — `public/sounds/bank.json`, written by tools/sounds/build.py from CC0 sources
//      (CREDITS.md beside it). It is a map of SLOT → clips. A slot is named for what the game
//      wants to say (`gun.hit` is "a round landed on a car"), never for where the file came from.
//   2. OVERRIDES — a vehicle, an actor or a world may replace any slot with its own clips. They
//      are a `SoundOverrides` record on the document: slot → entries. An entry is a bank clip
//      (`crash-heavy/slam-3`), another slot (`slot:gun.fire.shotgun`), an uploaded file on a
//      catalog asset (`asset:<id>/<file>`) or a URL. The game resolves them here, in scope order:
//      the thing's own, then the world's, then the bank.
//   3. PLAYBACK — `sfx.ts`, which owns the AudioContext, decodes clips and places them. It asks
//      this file what to play and nothing else.
//
// Everything here is pure so the picking, the scoping and the squeal crossfade can be tested
// without an AudioContext, and so the editor and the MCP vocabulary can list the slots.

/** The slots the game plays. The bank must have every one; an override may name any. */
export const SOUND_SLOTS = [
  'tire.squeal.loop', 'tire.skid',
  'crash.light', 'crash.medium', 'crash.heavy', 'crash.glass', 'crash.soft',
  'explosion', 'explosion.far', 'missile.launch',
  'gun.fire', 'gun.fire.shotgun', 'gun.hit', 'gun.hit.glass', 'gun.hit.ground',
] as const
export type SoundSlot = (typeof SOUND_SLOTS)[number]

/** What each slot is for — the words the editor and the code editor show beside it. */
export const SLOT_HELP: Record<SoundSlot, string> = {
  'tire.squeal.loop': 'light → heavy squeal loops, crossfaded by how hard the tyres are asked (one entry per level, in order)',
  'tire.skid': 'a skid that starts and stops: a lock-up, a handbrake turn',
  'crash.light': 'a tap: a kerb, a bollard, the side of a parked car',
  'crash.medium': 'a proper hit',
  'crash.heavy': 'a wreck: head-on, a roll, a wall at speed',
  'crash.glass': 'glazing going, laid over a heavy crash',
  'crash.soft': 'hitting something that is not metal: a pedestrian, a bush',
  'explosion': 'a missile landing, a car going up',
  'explosion.far': 'the same, heard from a distance',
  'missile.launch': 'a missile leaving the rail',
  'gun.fire': 'one round from the machine gun',
  'gun.fire.shotgun': 'one shotgun blast',
  'gun.hit': 'a round landing on a car or a structure',
  'gun.hit.glass': 'a round through a window',
  'gun.hit.ground': 'a round into the road or the verge',
}

export interface BankClip {
  /** path under /sounds/, with the .ogg extension the build wrote */
  file: string
  /** seconds */
  s: number
  /** RMS of the normalised cut, for the editor's level bars */
  rms?: number
}

export interface BankSlot {
  desc: string
  loop?: boolean
  /** the clips are levels, not variations: play them in order, never pick one at random */
  ordered?: boolean
  clips: BankClip[]
}

export interface BankManifest {
  version: number
  formats: string[]
  slots: Record<string, BankSlot>
}

/**
 * A document's own sounds: slot → entries. Absent slots fall through to the next scope. An empty
 * array is "silence for this slot", which a stealth vehicle might actually want.
 */
export type SoundOverrides = Partial<Record<SoundSlot, string[]>>

/** One thing to play, resolved: where it is, how long, whether it loops. */
export interface ResolvedClip {
  url: string
  s: number
  loop: boolean
}

export interface ResolveOpts {
  /** the extension the browser can decode: 'ogg' where Vorbis works, 'mp3' otherwise */
  ext: 'ogg' | 'mp3'
  /** where the bank is served from. Default '/sounds/' */
  base?: string
  /** an uploaded file on a catalog asset: `asset:<id>/<file>` */
  assetUrl?: (id: string, file: string) => string
}

/** Is this a slot the game knows? Narrowing, for documents read off disk. */
export function isSoundSlot(s: string): s is SoundSlot {
  return (SOUND_SLOTS as readonly string[]).includes(s)
}

/**
 * What is wrong with an overrides record, as the vehicle and actor validators report it. An
 * unknown slot is an error — it would silently never play — and an entry that is not a string is
 * too. Entry *contents* are not checked here: whether a file exists is the editor's job, and the
 * game treats a clip that will not load as a silent one.
 */
export function validateSoundOverrides(o: unknown, prefix = 'sounds'): string[] {
  const errors: string[] = []
  if (o === undefined || o === null) return errors
  if (typeof o !== 'object' || Array.isArray(o)) return [`${prefix} must be an object of slot → clips`]
  for (const [slot, entries] of Object.entries(o as Record<string, unknown>)) {
    if (!isSoundSlot(slot)) { errors.push(`${prefix}.${slot} is not a sound slot — one of ${SOUND_SLOTS.join(', ')}`); continue }
    if (!Array.isArray(entries)) { errors.push(`${prefix}.${slot} must be a list of clips`); continue }
    for (const [i, e] of entries.entries()) {
      if (typeof e !== 'string' || !e.trim()) errors.push(`${prefix}.${slot}[${i}] must be a clip: a bank path, slot:<name>, asset:<id>/<file> or a URL`)
    }
  }
  return errors
}

/**
 * The bank, plus the arithmetic of choosing from it.
 *
 * `pick` never returns the same clip twice running for a slot — two identical crash sounds a
 * frame apart is the thing people notice about game audio — and it keeps that memory per slot so
 * the gun's variety is not reset by a tyre squeal.
 */
export class SoundBank {
  readonly manifest: BankManifest
  private readonly opts: ResolveOpts
  private last = new Map<string, string>()
  private readonly base: string

  constructor(manifest: BankManifest, opts: ResolveOpts) {
    this.manifest = manifest
    this.opts = opts
    this.base = opts.base ?? '/sounds/'
  }

  /** every slot the bank has, with its description — for the editor and the vocabulary */
  slots(): { slot: SoundSlot; desc: string; clips: number; loop: boolean }[] {
    return SOUND_SLOTS.map((slot) => {
      const s = this.manifest.slots[slot]
      return { slot, desc: SLOT_HELP[slot], clips: s?.clips.length ?? 0, loop: !!s?.loop }
    })
  }

  /** the bank's own clips for a slot, as entries an override could name */
  bankEntries(slot: string): string[] {
    return (this.manifest.slots[slot]?.clips ?? []).map((c) => c.file.replace(/\.ogg$/, ''))
  }

  /**
   * The clips a slot resolves to under these scopes, nearest first: a vehicle's own record, then
   * the world's, then the bank. The first scope that MENTIONS the slot wins, even with an empty
   * list — that is how a document asks for silence.
   */
  resolve(slot: string, scopes: (SoundOverrides | null | undefined)[] = [], depth = 0): ResolvedClip[] {
    const loop = !!this.manifest.slots[slot]?.loop
    for (const sc of scopes) {
      const entries = sc?.[slot as SoundSlot]
      if (entries) return entries.flatMap((e) => this.entry(e, loop, scopes, depth))
    }
    return (this.manifest.slots[slot]?.clips ?? []).map((c) => ({ url: this.clipUrl(c.file), s: c.s, loop }))
  }

  /** one clip for a one-shot slot, not the one that played last */
  pick(slot: string, scopes: (SoundOverrides | null | undefined)[] = []): ResolvedClip | null {
    const clips = this.resolve(slot, scopes)
    if (!clips.length) return null
    if (clips.length === 1) return clips[0]
    const prev = this.last.get(slot)
    let c = clips[Math.floor(Math.random() * clips.length)]
    if (c.url === prev) c = clips[(clips.indexOf(c) + 1 + Math.floor(Math.random() * (clips.length - 1))) % clips.length]
    this.last.set(slot, c.url)
    return c
  }

  /** forget what played last — a test wants determinism, a scene change wants a fresh start */
  reset(): void {
    this.last.clear()
  }

  private clipUrl(file: string): string {
    return this.base + file.replace(/\.ogg$/, '') + '.' + this.opts.ext
  }

  private entry(e: string, loop: boolean, scopes: (SoundOverrides | null | undefined)[], depth: number): ResolvedClip[] {
    if (e.startsWith('slot:')) {
      // another slot's clips — guarded against a slot that points at itself
      return depth > 3 ? [] : this.resolve(e.slice(5), scopes, depth + 1)
    }
    if (e.startsWith('asset:')) {
      const rest = e.slice(6)
      const i = rest.indexOf('/')
      if (i <= 0 || !this.opts.assetUrl) return []
      return [{ url: this.opts.assetUrl(rest.slice(0, i), rest.slice(i + 1)), s: 0, loop }]
    }
    if (/^(https?:)?\/\//.test(e) || e.startsWith('/') || e.startsWith('data:') || e.startsWith('blob:')) return [{ url: e, s: 0, loop }]
    // a bank clip, with or without its extension; the manifest supplies its length
    const bare = e.replace(/\.(ogg|mp3)$/, '')
    const known = Object.values(this.manifest.slots).flatMap((s) => s.clips).find((c) => c.file.replace(/\.ogg$/, '') === bare)
    return [{ url: this.clipUrl(bare + '.ogg'), s: known?.s ?? 0, loop }]
  }
}

/**
 * THE SQUEAL. One number in — how hard the tyres are being asked, 0 (gripping) to 1 (gone) — and
 * a gain per level out, plus a playback rate. Light carries the bottom of the range, heavy the top,
 * medium the middle, each fading into the next, and the whole thing opens from silence over the
 * first quarter so a car cornering briskly on a dry road is not already squealing.
 *
 * With fewer levels than three the clips cover the range evenly; with one, it is just a gain.
 */
export function squealMix(level: number, levels: number): { gains: number[]; rate: number } {
  const t = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0))
  const open = t <= 0 ? 0 : smooth(Math.min(1, t / 0.25))
  const n = Math.max(0, levels)
  const gains: number[] = []
  if (n === 1) gains.push(open)
  else if (n > 1) {
    // level i peaks at i/(n-1) and is gone one slot either side: a triangle crossfade that sums to 1
    for (let i = 0; i < n; i++) {
      const centre = i / (n - 1)
      const d = Math.abs(t - centre) * (n - 1)
      gains.push(open * Math.max(0, 1 - d))
    }
  }
  return { gains, rate: 0.92 + 0.2 * t }
}

function smooth(x: number): number {
  return x * x * (3 - 2 * x)
}

/** A crash, graded off the physics impulse (N·s) into a slot, with the gain it deserves. */
export function crashSlot(peakNs: number, light: number, heavy: number): { slot: SoundSlot; gain: number; glass: boolean } | null {
  if (!(peakNs > 0) || peakNs < light * 0.35) return null
  if (peakNs < light) return { slot: 'crash.light', gain: 0.5 + 0.5 * (peakNs / light), glass: false }
  if (peakNs < heavy) return { slot: 'crash.medium', gain: 0.8 + 0.2 * ((peakNs - light) / Math.max(1, heavy - light)), glass: false }
  return { slot: 'crash.heavy', gain: 1, glass: peakNs > heavy * 1.5 }
}
