// Loading a cabinet's artwork, in the knowledge that most of it does not exist yet.
//
// Right now every game has a marquee and nothing else (see ART.md for the prompt that produces the
// rest). A missing panel is the normal case, not an error: the cabinet just shows painted body
// where that panel would have gone. So this resolves every panel to either a texture or null, never
// rejects, and says nothing to the console about a file that was never promised.

import { SRGBColorSpace, type Texture, TextureLoader, VideoTexture } from 'three'

export type PanelName = 'marquee' | 'side-left' | 'side-right' | 'panel' | 'bezel' | 'attract'

export const PANELS: readonly PanelName[] = ['marquee', 'side-left', 'side-right', 'panel', 'bezel', 'attract']

interface Panel {
  texture: Texture
  aspect: number
}

export class CabinetArt {
  private readonly panels = new Map<PanelName, Panel>()
  /**
   * The attract loop: a few seconds of the game's own title screen, filmed by
   * `scripts/capture-attract.mjs` and played on the cabinet's glass. A cabinet with a dark pane
   * where its screen should be is the one thing that stops it reading as a machine that is on.
   */
  private video: HTMLVideoElement | null = null
  private videoTex: VideoTexture | null = null

  readonly gameId: string

  private constructor(gameId: string) {
    this.gameId = gameId
  }

  static async load(gameId: string): Promise<CabinetArt> {
    const art = new CabinetArt(gameId)
    const loader = new TextureLoader()
    await Promise.all(
      PANELS.map(async (name) => {
        const url = `/cabinets/${gameId}/${name}.webp`
        // A HEAD first, because a 404 reaching TextureLoader is an unhandled image error in the
        // console for every panel nobody has drawn yet — three per game, every single load.
        try {
          const head = await fetch(url, { method: 'HEAD' })
          if (!head.ok) return
        } catch {
          return
        }
        try {
          const texture = await loader.loadAsync(url)
          texture.colorSpace = SRGBColorSpace
          texture.anisotropy = 4
          const { width, height } = texture.image as { width: number; height: number }
          art.panels.set(name, { texture, aspect: width / height })
        } catch {
          /* the file is there but unreadable; the cabinet does without it */
        }
      }),
    )
    await art.loadAttract()
    return art
  }

  /**
   * The loop, if one has been filmed for this game. Muted and inline, which is what a browser will
   * let play without anyone having clicked anything; paused until its cabinet is the selected one,
   * because three video decoders running behind a menu is three too many.
   */
  private async loadAttract(): Promise<void> {
    const url = `/cabinets/${this.gameId}/attract.webm`
    try {
      const head = await fetch(url, { method: 'HEAD' })
      if (!head.ok) return
    } catch {
      return
    }
    const el = document.createElement('video')
    el.src = url
    el.loop = true
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    this.video = el
    const tex = new VideoTexture(el)
    tex.colorSpace = SRGBColorSpace
    this.videoTex = tex
    // Decode one frame now, so a cabinet nobody is looking at shows a still of its game rather than
    // a black pane. Paused video keeps whatever frame it is on.
    el.currentTime = 1
    try {
      await el.play()
      window.setTimeout(() => el.pause(), 120)
    } catch {
      /* a browser that will not autoplay even muted: the pane stays dark, which is survivable */
    }
  }

  /** The attract loop as a texture, or null where none was filmed. */
  attract(): Texture | null {
    return this.videoTex ?? this.texture('attract')
  }

  /** Running only on the cabinet someone is looking at. */
  setAttractPlaying(on: boolean): void {
    if (!this.video) return
    if (on) void this.video.play().catch(() => undefined)
    else this.video.pause()
  }

  has(name: PanelName): boolean {
    return this.panels.has(name)
  }

  texture(name: PanelName): Texture | null {
    return this.panels.get(name)?.texture ?? null
  }

  /** Width over height of a panel's artwork, or null if there is none. Geometry follows this. */
  aspect(name: PanelName): number | null {
    return this.panels.get(name)?.aspect ?? null
  }

  dispose(): void {
    for (const p of this.panels.values()) p.texture.dispose()
    this.panels.clear()
    this.videoTex?.dispose()
    this.videoTex = null
    if (this.video) {
      // Pause *and* drop the source: a video element left with a src keeps its decoder and keeps
      // pulling the file, long after the lobby it belonged to has gone.
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load()
      this.video = null
    }
  }
}
