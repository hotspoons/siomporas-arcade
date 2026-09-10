// The replay transport: play/pause, a scrubbable timeline, jump buttons, playback
// speed and the camera picker, along the bottom of the screen while you watch.
//
// The keys still do everything they did (space, ← →, ↑ ↓, C, 1–4, Esc) — this is
// the same controls with a handle on them, because scrubbing a run by holding an
// arrow key and guessing is no way to find the moment you crashed.

import type { CameraMode } from '../render/CameraRig'
import type { ReplayPlayer } from './Replay'

export interface ReplayBarActions {
  togglePlay(): void
  seek(seconds: number): void
  setSpeed(v: number): void
  setCamera(mode: CameraMode): void
  exit(): void
}

const CAMERAS: { mode: CameraMode; label: string; key: string }[] = [
  { mode: 'chase', label: 'THIRD', key: '1' },
  { mode: 'hood', label: 'FIRST', key: '2' },
  { mode: 'heli', label: 'HELI', key: '3' },
  { mode: 'tv', label: 'TV', key: '4' },
]

/** Playback speeds the ‹ › stepper walks through, and what ↑ ↓ do. */
export const SPEEDS = [0.125, 0.25, 0.5, 1, 2, 4]

/** Seconds of stillness before the bar fades down, so it isn't in the shot. */
const IDLE_FADE = 2.6

export class ReplayBar {
  readonly el: HTMLElement
  private readonly playBtn: HTMLButtonElement
  private readonly track: HTMLElement
  private readonly fill: HTMLElement
  private readonly head: HTMLElement
  private readonly clock: HTMLElement
  private readonly speedLabel: HTMLElement
  private readonly title: HTMLElement
  private readonly camButtons = new Map<CameraMode, HTMLButtonElement>()
  private readonly actions: ReplayBarActions
  /** While dragging the head: the play state to put back on release. */
  private scrubbing = false
  private resumeAfterScrub = false
  private idle = 0
  private hovering = false
  /** What the player last told us, mirrored so the click handlers can do arithmetic on it. */
  private time = 0
  private duration = 0
  private playing = false
  private speed = 1
  private last = { playing: false, fill: -1, clock: '', speed: '', camera: '' as string }

  constructor(parent: HTMLElement, actions: ReplayBarActions) {
    this.actions = actions
    this.el = document.createElement('div')
    this.el.className = 'replay-bar hidden'
    this.el.innerHTML = `
      <div class="row top"><span class="file" data-title></span><span class="keys">SPACE PLAY &middot; &lt; &gt; SCRUB &middot; C CAMERA &middot; ESC EXIT</span></div>
      <div class="row">
        <button class="tp play" data-act="play" tabindex="-1" title="Play / pause (Space)">▶</button>
        <button class="tp" data-act="start" tabindex="-1" title="Back to the start">⏮</button>
        <button class="tp" data-act="back" tabindex="-1" title="Back 5 seconds">−5</button>
        <button class="tp" data-act="fwd" tabindex="-1" title="Forward 5 seconds">+5</button>
        <div class="scrub" data-track><div class="fill" data-fill></div><div class="head" data-head></div></div>
        <span class="clock" data-clock>0:00 / 0:00</span>
        <span class="speed"><button class="tp" data-act="slower" tabindex="-1" title="Slower (↓)">‹</button><span data-speed>1×</span><button class="tp" data-act="faster" tabindex="-1" title="Faster (↑)">›</button></span>
        <span class="cams" data-cams></span>
        <button class="tp exit" data-act="exit" tabindex="-1" title="Stop watching (Esc)">✕</button>
      </div>`
    parent.appendChild(this.el)
    const q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T
    this.playBtn = q<HTMLButtonElement>('[data-act="play"]')
    this.track = q('[data-track]')
    this.fill = q('[data-fill]')
    this.head = q('[data-head]')
    this.clock = q('[data-clock]')
    this.speedLabel = q('[data-speed]')
    this.title = q('[data-title]')

    const cams = q('[data-cams]')
    for (const c of CAMERAS) {
      const b = document.createElement('button')
      b.className = 'tp cam'
      b.textContent = c.label
      b.title = `${c.label} camera (${c.key})`
      b.tabIndex = -1
      b.addEventListener('click', () => {
        this.actions.setCamera(c.mode)
        b.blur()
      })
      cams.appendChild(b)
      this.camButtons.set(c.mode, b)
    }

    this.el.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-act]')
      if (!btn) return
      btn.blur() // otherwise Space would work the focused button as well as the transport
      switch (btn.dataset.act) {
        case 'play':
          this.actions.togglePlay()
          break
        case 'start':
          this.actions.seek(0)
          break
        case 'back':
          this.actions.seek(this.time - 5)
          break
        case 'fwd':
          this.actions.seek(this.time + 5)
          break
        case 'slower':
          this.stepSpeed(-1)
          break
        case 'faster':
          this.stepSpeed(1)
          break
        case 'exit':
          this.actions.exit()
          break
      }
    })

    // Scrubbing: drag anywhere on the track. Playback holds while you drag and picks up where you left it.
    this.track.addEventListener('pointerdown', (e) => {
      this.scrubbing = true
      this.resumeAfterScrub = this.playing
      this.track.setPointerCapture(e.pointerId)
      this.seekToPointer(e)
    })
    this.track.addEventListener('pointermove', (e) => {
      if (this.scrubbing) this.seekToPointer(e)
    })
    const end = () => {
      if (!this.scrubbing) return
      this.scrubbing = false
      if (this.resumeAfterScrub && !this.playing) this.actions.togglePlay()
    }
    this.track.addEventListener('pointerup', end)
    this.track.addEventListener('pointercancel', end)
    this.el.addEventListener('pointerenter', () => (this.hovering = true))
    this.el.addEventListener('pointerleave', () => (this.hovering = false))
    // Reaching for the bar brings it back before the pointer gets there.
    window.addEventListener('pointermove', () => {
      if (!this.el.classList.contains('hidden')) this.wake()
    })
  }

  private stepSpeed(dir: number): void {
    const i = SPEEDS.indexOf(this.speed)
    const at = i < 0 ? SPEEDS.indexOf(1) : i
    this.actions.setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, at + dir))])
  }

  private seekToPointer(e: PointerEvent): void {
    const r = this.track.getBoundingClientRect()
    const t = r.width > 0 ? (e.clientX - r.left) / r.width : 0
    this.actions.seek(Math.max(0, Math.min(1, t)) * this.duration)
    this.wake()
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v)
    if (v) this.wake()
  }

  /** Name the run being watched, shown along the top of the bar. */
  setTitle(text: string): void {
    this.title.textContent = text
  }

  /** Any input at all brings the bar back to full opacity. */
  wake(): void {
    this.idle = 0
    this.el.classList.remove('faded')
  }

  update(p: ReplayPlayer, camera: CameraMode, dt: number): void {
    this.time = p.time
    this.duration = p.duration
    this.playing = p.playing
    this.speed = p.speed
    // Out of the way while it plays and nothing is being touched.
    this.idle = this.scrubbing || this.hovering || !p.playing ? 0 : this.idle + dt
    this.el.classList.toggle('faded', this.idle > IDLE_FADE)

    if (p.playing !== this.last.playing) {
      this.last.playing = p.playing
      this.playBtn.textContent = p.playing ? '❙❙' : '▶'
      this.playBtn.classList.toggle('playing', p.playing)
    }
    const frac = p.duration > 0 ? p.time / p.duration : 0
    if (Math.abs(frac - this.last.fill) > 0.0005) {
      this.last.fill = frac
      const pct = `${(frac * 100).toFixed(2)}%`
      this.fill.style.width = pct
      this.head.style.left = pct
    }
    const clock = `${clockText(p.time)} / ${clockText(p.duration)}`
    if (clock !== this.last.clock) {
      this.last.clock = clock
      this.clock.textContent = clock
    }
    const speed = p.speed === 1 ? '1×' : p.speed < 1 ? `1/${Math.round(1 / p.speed)}×` : `${p.speed}×`
    if (speed !== this.last.speed) {
      this.last.speed = speed
      this.speedLabel.textContent = speed
    }
    if (camera !== this.last.camera) {
      this.last.camera = camera
      for (const [mode, b] of this.camButtons) b.classList.toggle('on', mode === camera)
    }
  }
}

function clockText(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const r = s - m * 60
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`
}
