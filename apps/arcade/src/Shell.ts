// The shell: the part of the page that never goes away.
//
// It owns the URL, the fade, the error card, and exactly one mounted module at a time — the lobby
// at `/`, a game at `/<id>`. Mounting means digging a fresh hole (a container and a canvas) and
// handing it to the module; unmounting means the module gives back its loop, its GL context and
// its listeners, and then the hole is filled in. Nothing is reused between mounts, deliberately:
// a shared canvas would mean a shared GL context, and one game's leftover GPU state showing up in
// the next is a class of bug that is very hard to see and very hard to find.
//
// (Sharing one renderer across games is the obvious next thing to try — it would make the switch
// instant rather than merely quick. It needs each game's RenderWorld to stop owning its renderer
// first. See the note in README.md.)

import { Router, samePath } from '@apex/engine/app/Router'
import type { GameHost, GameModule, MountedGame } from '@apex/engine/app/GameModule'
import { findGame } from './catalog'
import { lobby } from './lobby/Lobby'

/** Long enough to cover the swap, short enough not to be a wait. Matches the CSS transition. */
const FADE_MS = 220

interface Mount {
  id: string
  container: HTMLElement
  canvas: HTMLCanvasElement
  game: MountedGame
}

export class Shell {
  private readonly router = new Router()
  private readonly fade: HTMLElement
  private readonly boot: HTMLElement
  private mount: Mount | null = null
  /** Bumped on every navigation, so a mount that lost the race can tell and stand down. */
  private generation = 0

  private readonly root: HTMLElement

  constructor(root: HTMLElement) {
    this.root = root
    this.fade = document.createElement('div')
    this.fade.className = 'arcade-fade'
    this.boot = document.createElement('div')
    this.boot.className = 'arcade-boot'
    root.append(this.fade, this.boot)

    this.router.subscribe(() => void this.sync())

    // A game that throws after it has started is the shell's problem, not the game's: it is still
    // holding a GL context and a loop, and the player needs a way back to the marquees.
    window.addEventListener('error', (e) => this.fail('SOMETHING BROKE', String(e.error?.stack ?? e.message)))
    window.addEventListener('unhandledrejection', (e) => this.fail('SOMETHING BROKE', String((e.reason as Error)?.stack ?? e.reason)))

    void this.sync()
  }

  /** The module the current URL asks for. Anything unrecognised is the lobby. */
  private resolve(id: string): { id: string; load: () => Promise<GameModule> } {
    if (id === '') return { id: '', load: async () => lobby }
    const game = findGame(id)
    if (!game) return { id: '', load: async () => lobby }
    return { id: game.id, load: game.load }
  }

  private async sync(): Promise<void> {
    const asked = this.router.path[0] ?? ''
    const want = this.resolve(asked)
    // An address that names no game is not an error worth a page for; quietly correct it.
    if (want.id !== asked) this.router.replace([])
    if (this.mount?.id === want.id) return
    await this.swap(want)
  }

  private async swap(want: { id: string; load: () => Promise<GameModule> }): Promise<void> {
    const gen = ++this.generation
    const stale = (): boolean => gen !== this.generation

    this.clearFailure()
    await this.setFaded(true)
    if (stale()) return

    this.unmount()

    // Fetch the chunk before digging the hole, so a slow network shows the loading card over black
    // rather than over an empty canvas.
    this.boot.textContent = 'LOADING'
    this.boot.classList.add('on')
    let module: GameModule
    try {
      module = await want.load()
    } catch (err) {
      this.fail('COULD NOT LOAD', String((err as Error)?.stack ?? err))
      return
    }
    if (stale()) return

    const container = document.createElement('div')
    container.className = 'arcade-mount'
    container.dataset.game = want.id || 'lobby'
    const canvas = document.createElement('canvas')
    canvas.className = 'game'
    container.appendChild(canvas)
    // Behind the fade and the boot card, both of which the shell keeps at the end of the root.
    this.root.insertBefore(container, this.fade)

    const host = this.makeHost(want.id, container, canvas, gen)
    let game: MountedGame
    try {
      game = await module.mount(host)
    } catch (err) {
      container.remove()
      this.fail('COULD NOT START', String((err as Error)?.stack ?? err))
      return
    }
    if (stale()) {
      // Navigated away while it was building. It is fully alive, so it has to be fully put down.
      game.dispose()
      container.remove()
      return
    }

    this.mount = { id: want.id, container, canvas, game }
    this.boot.classList.remove('on')
    await this.setFaded(false)
  }

  private makeHost(id: string, container: HTMLElement, canvas: HTMLCanvasElement, gen: number): GameHost {
    const route = id === '' ? [] : [id]
    return {
      container,
      canvas,
      router: this.router,
      route,
      status: (text) => {
        if (gen !== this.generation) return
        this.boot.textContent = text ?? ''
        this.boot.classList.toggle('on', text !== null)
      },
      exit: () => {
        if (!samePath(this.router.path, [])) this.router.push([])
      },
      fail: (title, detail) => this.fail(title, detail),
    }
  }

  private unmount(): void {
    if (!this.mount) return
    const { container, game, canvas } = this.mount
    this.mount = null
    try {
      game.dispose()
    } catch (err) {
      console.error('[unmount]', err)
    }
    // Drop the canvas out of the document before the container, so the browser can reclaim its GL
    // context promptly rather than at the next collection.
    canvas.remove()
    container.remove()
  }

  private setFaded(on: boolean): Promise<void> {
    this.fade.classList.toggle('on', on)
    return new Promise((r) => setTimeout(r, FADE_MS))
  }

  // --- failure -------------------------------------------------------------

  private failure: HTMLElement | null = null

  private clearFailure(): void {
    this.failure?.remove()
    this.failure = null
  }

  fail(title: string, detail: string): void {
    // The first failure is the interesting one; anything it cascades into is noise.
    if (this.failure) return
    this.unmount()
    const box = document.createElement('div')
    box.className = 'arcade-fatal'
    box.innerHTML = `<h2></h2><pre></pre><div><button class="back">BACK TO THE ARCADE</button><button class="reload">RELOAD</button></div>`
    box.querySelector('h2')!.textContent = title
    box.querySelector('pre')!.textContent = detail
    box.querySelector<HTMLElement>('.back')!.addEventListener('click', () => {
      this.clearFailure()
      this.router.push([])
      void this.sync()
    })
    box.querySelector<HTMLElement>('.reload')!.addEventListener('click', () => location.reload())
    this.root.appendChild(box)
    this.failure = box
    this.boot.classList.remove('on')
    this.fade.classList.remove('on')
  }

  /** Handles for the dev operator shell. */
  get bridge(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {
      shell: this,
      router: this.router,
      go: (id: string) => this.router.push(id ? [id] : []),
    }
    // Defined rather than declared, so they stay plain property reads on an object whose `this`
    // is the bridge context and not the shell.
    // 'lobby' rather than the lobby's actual id, which is the empty string and reads as nothing.
    Object.defineProperty(ctx, 'at', { get: () => (this.mount ? this.mount.id || 'lobby' : null), enumerable: true })
    Object.defineProperty(ctx, 'game', { get: () => this.mount?.game.bridge ?? null, enumerable: true })
    return ctx
  }
}
