// Loading a cabinet's artwork, in the knowledge that most of it does not exist yet.
//
// Right now every game has a marquee and nothing else (see ART.md for the prompt that produces the
// rest). A missing panel is the normal case, not an error: the cabinet just shows painted body
// where that panel would have gone. So this resolves every panel to either a texture or null, never
// rejects, and says nothing to the console about a file that was never promised.

import { SRGBColorSpace, type Texture, TextureLoader } from 'three'

export type PanelName = 'marquee' | 'side' | 'panel' | 'bezel' | 'attract'

export const PANELS: readonly PanelName[] = ['marquee', 'side', 'panel', 'bezel', 'attract']

interface Panel {
  texture: Texture
  aspect: number
}

export class CabinetArt {
  private readonly panels = new Map<PanelName, Panel>()

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
    return art
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
  }
}
