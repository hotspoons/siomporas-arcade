// What the arcade shell hands a game, and what it gets back.
//
// A game is not an application any more; it is something the shell mounts into a hole it has
// already dug — a canvas, a container to hang overlays on, and a stretch of the URL it owns. When
// the player walks back out to the marquees, `dispose()` has to leave the page as it found it,
// because the next game is about to be mounted into the same page.
//
// The engine defines the contract and knows nothing about which games exist; the shell knows which
// games exist and nothing about how any of them works. Each game's module lives next to that
// game's own code, so the game keeps ownership of its own teardown.

import type { RoutePath, Router } from './Router'

export interface GameHost {
  /**
   * Where the game's DOM goes: HUD, menus, tuning panel, everything. The shell removes this whole
   * element on unmount, so DOM parented to it needs no teardown of its own — only listeners on
   * `window`/`document` and resources outside the DOM do.
   */
  readonly container: HTMLElement
  /** A canvas made fresh for this mount, and destroyed with it along with its GL context. */
  readonly canvas: HTMLCanvasElement
  /** Loading text over the black while the game builds itself. `null` clears it. */
  status(text: string | null): void
  /** The app's URL. A game binds its menus to it: `menus.bindRouter(host.router, host.route)`. */
  readonly router: Router
  /** The path this game is mounted at — `['radrun']`. Nested menus append to it. */
  readonly route: RoutePath
  /** Leave the game and go back to the marquees. */
  exit(): void
  /** Something went wrong badly enough that the game cannot run. Puts the player back in the lobby. */
  fail(title: string, detail: string): void
}

export interface MountedGame {
  /**
   * Give back everything: stop the loop, drop the GL context, close the audio, unhook every
   * listener on `window`. The shell removes `host.container` and `host.canvas` afterwards, so
   * neither needs touching here.
   */
  dispose(): void
  /** Handles for the dev operator shell (`just bridge`). Absent in production builds. */
  bridge?: Record<string, unknown>
}

export interface GameModule {
  /** The URL segment and asset-directory name: `radrun`, `stuntin`, `apex`. */
  readonly id: string
  mount(host: GameHost): Promise<MountedGame>
}
