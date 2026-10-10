// The Escape menu: pause, settings as sub-screens, controls with rebinding, audio with a mute.
//
// Ported from Turbo Radrun (apps/coast/src/app/menus.ts) on the engine's MenuStack — the same
// screens-as-data, the same keyboard/pad/mouse navigation, the same tap-to-set / hold-to-add
// rebinding. What is corridor's own is the HOST: the menu knows nothing about the car, the sky or
// the layers, it asks `GameMenuHost` for a getter and a setter per setting and draws whatever it
// is handed. `main.ts` implements the host over the viewer's real state; a test can hand it a
// fake and press the buttons.
//
// EVERY TAB AND EVERY ROW ASKS THE POLICY FIRST. `policy.allows('display.theme')` is the one
// question, and the developer dialog asks it too, so a program that hides the theme picker hides
// it in both views with one call.
import { MenuStack, type MenuItem, type MenuScreen } from '@apex/engine/app/Menus'
import { BindingCapture, applyBinding, holdMeter } from '@apex/engine/app/BindingCapture'
import { keyLabel, padBindingLabel } from '@apex/engine/input/bindings'
import type { UiEdges } from '@apex/engine/input/UiEdges'
import type { GameInput } from '../game/move/gameinput'
import type { GamePolicy, UiMode } from '../game/session/gamepolicy'
import { ACTIONS, ACTION_LABELS, type Action, type GameSettings } from '../game/session/gamesettings'
import type { UiSound } from './uisound'

/** a setting with a fixed set of values: the menu steps through them with ‹ › */
export interface Choice<T extends string = string> {
  options: { value: T; label: string }[]
  get(): T
  set(v: T): void
}
export interface Flag {
  get(): boolean
  set(v: boolean): void
}

export interface GameMenuHost {
  settings: GameSettings
  policy: GamePolicy
  input: GameInput
  sounds: UiSound
  /** close the menu and let the world run */
  resume(): void
  /** back to the start point, the program and the races reset */
  restart(): void
  /** the interface: game or developer */
  mode: Choice<UiMode>
  /** open the F6 tuning panel */
  tuning(): void
  transport: { driving(): boolean; setDriving(on: boolean): void }
  race: { active(): boolean; abandon(): void }
  display: {
    season: Choice
    style: Choice
    relief: Choice
    trees: Choice
    weather: Choice
    perf: Flag
    aa: Choice
    detail: Choice
    theme: Choice
    interface: Flag
  }
  layers: { list(): { id: string; label: string; group: string }[]; get(id: string): boolean; set(id: string, on: boolean): void }
  recover: Choice<'level' | 'on' | 'off'>
  /** the settings changed: push the volumes at the audio, the bindings at the input */
  applyAudio(): void
  applyBindings(): void
  /**
   * The world's stages, for a level select — where the finish screen's "Exit to menu" leads when
   * there is somewhere else to go. Absent, or one stage: no Levels row.
   */
  levels?: { list(): { id: string; name: string }[]; current(): string | null; open(id: string): void }
}

export class GameMenu {
  readonly stack: MenuStack
  private readonly h: GameMenuHost
  /** a rebind capture owns the keyboard: Escape belongs to it, not to `escape()` */
  private capturing = false

  constructor(host: GameMenuHost, parent: HTMLElement = document.body) {
    this.h = host
    this.stack = new MenuStack(parent)
    this.stack.onNavigate = () => host.sounds.move()
    this.stack.onSelect = () => host.sounds.select()
  }

  get open(): boolean {
    return this.stack.open
  }

  /** the root: the pause screen */
  show(): void {
    this.stack.replace(this.pause())
    this.h.sounds.open()
  }

  /** straight to a screen, for the developer dialog's "Rebind…" and the like */
  showAt(screen: 'controls' | 'settings' | 'audio'): void {
    this.stack.replace(this.pause())
    this.stack.push(this.settings())
    if (screen === 'controls') this.stack.push(this.controls())
    else if (screen === 'audio') this.stack.push(this.audio())
  }

  close(): void {
    this.stack.closeAll()
  }

  refresh(): void {
    this.stack.refresh()
  }

  /** the policy moved under an open menu: draw the current screen again from scratch */
  policyChanged(): void {
    const id = this.stack.current?.id
    if (!id || !this.open) return
    const screens: Record<string, () => MenuScreen> = {
      pause: () => this.pause(), settings: () => this.settings(), levels: () => this.levels(), display: () => this.display(),
      layers: () => this.layers(), audio: () => this.audio(), controls: () => this.controls(),
    }
    const make = screens[id]
    if (!make) return
    this.stack.pop()
    this.stack.push(make())
  }

  /** per frame while open */
  handle(ui: UiEdges): void {
    this.stack.handle(ui)
  }

  /**
   * Escape from the keyboard. On the root it resumes; deeper in it steps back out — "inside a
   * settings screen it should step back out of that screen, not out of the game" (coast).
   */
  escape(): void {
    if (!this.open || this.capturing) return
    const cur = this.stack.current
    if (!cur || cur.id === 'pause') { this.h.resume(); return }
    if (cur.onBack) cur.onBack()
    else this.stack.pop()
    this.h.sounds.move()
  }

  // ---- screens -------------------------------------------------------------------------------

  private pause(): MenuScreen {
    const h = this.h
    const p = h.policy
    const s = () => h.settings.data
    const items: MenuItem[] = [{ kind: 'action', label: 'Resume', onSelect: () => h.resume() }]
    if (p.allows('game.restart')) items.push({ kind: 'action', label: 'Restart', hint: 'back to the start point', onSelect: () => h.restart() })
    if (h.race.active()) items.push({ kind: 'action', label: 'Abandon the race', danger: true, onSelect: () => { h.race.abandon(); h.resume() } })
    if (p.transport && p.allows('game.transport')) {
      items.push({
        kind: 'action',
        label: h.transport.driving() ? 'Leave the car' : 'Drive',
        hint: h.transport.driving() ? 'fly the free camera' : 'get in the car',
        onSelect: () => { h.transport.setDriving(!h.transport.driving()); h.resume() },
      })
    }
    if (p.allows('game.physics')) {
      const opts = ['world', 'on', 'off'] as const
      items.push({
        kind: 'choice', label: 'Physics', options: ['the world’s default', 'on', 'off'],
        hint: 'solid buildings, traffic you can hit; takes effect when the world next loads',
        get: () => Math.max(0, opts.indexOf(s().physics ?? 'world')),
        set: (i) => h.settings.update((x) => (x.physics = opts[i] ?? 'world')),
      })
    }
    if (p.allows('audio.mute')) {
      items.push({
        kind: 'toggle',
        label: 'Mute',
        get: () => s().audio.muted,
        set: (v) => { h.settings.update((d) => (d.audio.muted = v)); h.applyAudio() },
      })
    }
    items.push({
      kind: 'action',
      label: document.fullscreenElement ? 'Leave full screen' : 'Full screen',
      onSelect: () => {
        if (document.fullscreenElement) void document.exitFullscreen()
        else void document.documentElement.requestFullscreen()
        h.resume()
      },
    })
    const stages = h.levels?.list() ?? []
    if (stages.length > 1 && p.allows('game.levels')) items.push({ kind: 'action', label: 'Levels', hint: `${stages.length} in this world`, onSelect: () => this.stack.push(this.levels()) })
    items.push({ kind: 'action', label: 'Settings', hint: 'display · layers · audio · controls', onSelect: () => this.stack.push(this.settings()) })
    if (p.allows('game.tuning')) items.push({ kind: 'action', label: 'Tuning panel', hint: 'F6 — the live knobs', onSelect: () => h.tuning() })
    if (p.developer && p.allows('game.developer')) {
      items.push({
        kind: 'toggle',
        label: 'Developer view',
        hint: 'the bar, the world picker, the search box and the readout',
        get: () => h.mode.get() === 'dev',
        set: (v) => h.mode.set(v ? 'dev' : 'game'),
      })
    }
    return {
      id: 'pause',
      title: 'Paused',
      items,
      footer: h.input.padConnected ? 'A select · B back · Start resumes' : 'Enter selects · Esc resumes',
      onBack: () => h.resume(),
    }
  }

  /** the level select: every stage in this world, the one being played marked */
  private levels(): MenuScreen {
    const L = this.h.levels!
    const cur = L.current()
    const items: MenuItem[] = L.list().map((l) => ({
      kind: 'action' as const,
      label: l.name,
      hint: l.id === cur ? 'playing now — from the top' : undefined,
      onSelect: () => L.open(l.id),
    }))
    return { id: 'levels', title: 'Levels', items, footer: 'Enter plays it · Esc back' }
  }

  private settings(): MenuScreen {
    const p = this.h.policy
    const items: MenuItem[] = []
    if (p.allows('display')) items.push({ kind: 'action', label: 'Display', hint: 'season, weather, trees, rendering, theme', onSelect: () => this.stack.push(this.display()) })
    if (p.allows('layers')) items.push({ kind: 'action', label: 'Layers', hint: 'what is drawn', onSelect: () => this.stack.push(this.layers()) })
    if (p.allows('audio')) items.push({ kind: 'action', label: 'Audio', hint: 'volumes and mute', onSelect: () => this.stack.push(this.audio()) })
    if (p.allows('controls')) items.push({ kind: 'action', label: 'Controls', hint: 'keys, pad, rumble', onSelect: () => this.stack.push(this.controls()) })
    if (p.allows('game.tuning')) items.push({ kind: 'action', label: 'Tuning panel', hint: 'F6 — every live knob, by tab', onSelect: () => this.h.tuning() })
    if (!items.length) items.push({ kind: 'info', label: 'This level has no settings to change' })
    return { id: 'settings', title: 'Settings', items, footer: '← → adjust · Esc back' }
  }

  private display(): MenuScreen {
    const d = this.h.display
    const p = this.h.policy
    const s = () => this.h.settings.data
    const items: MenuItem[] = []
    const sec = (label: string) => items.push({ kind: 'info', label })
    if (['display.season', 'display.style', 'display.relief', 'display.trees', 'display.weather'].some((id) => p.allows(id))) sec('Conditions')
    if (p.allows('display.season')) items.push(choice('Season', d.season))
    if (p.allows('display.style')) items.push(choice('Style', d.style))
    if (p.allows('display.relief')) items.push(choice('Relief', d.relief, 'terrain exaggeration — the world reloads'))
    if (p.allows('display.trees')) items.push(choice('Trees', d.trees))
    if (p.allows('display.weather')) items.push(choice('Weather', d.weather))
    if (['display.perf', 'display.aa', 'display.detail'].some((id) => p.allows(id))) sec('Rendering')
    if (p.allows('display.detail')) items.push(choice('Detail', d.detail, 'how much geometry traffic, your car and props draw with — resets the LOD knobs in F6'))
    if (p.allows('display.aa')) items.push(choice('Anti-aliasing', d.aa, 'MSAA reloads the page'))
    if (p.allows('display.perf')) items.push(flag('Performance stats', d.perf, 'F7 — frame rate, p95/p99, draw calls, heap'))
    if (['display.theme', 'display.interface', 'display.units'].some((id) => p.allows(id))) sec('Interface')
    if (p.allows('display.units')) {
      items.push({
        kind: 'choice', label: 'Units', options: ['mph', 'km/h'],
        get: () => (s().units === 'kmh' ? 1 : 0),
        set: (i) => this.h.settings.update((x) => (x.units = i === 1 ? 'kmh' : 'mph')),
      })
    }
    if (p.allows('display.theme')) items.push(choice('Theme', d.theme))
    if (p.allows('display.interface')) items.push(flag('Hide the interface', d.interface, 'M — everything but the world'))
    return { id: 'display', title: 'Display', wide: true, items, footer: '← → adjust · Esc back' }
  }

  private layers(): MenuScreen {
    const L = this.h.layers
    const p = this.h.policy
    const items: MenuItem[] = []
    let group = ''
    for (const l of L.list()) {
      if (!p.allows(`layers.${l.id}`)) continue
      if (l.group !== group) { group = l.group; items.push({ kind: 'info', label: group }) }
      items.push({ kind: 'toggle', label: l.label, get: () => L.get(l.id), set: (v) => L.set(l.id, v) })
    }
    if (!items.length) items.push({ kind: 'info', label: 'Nothing to switch here' })
    return { id: 'layers', title: 'Layers', wide: true, items, footer: 'Enter or ← → toggles · Esc back' }
  }

  private audio(): MenuScreen {
    const h = this.h
    const p = h.policy
    const s = () => h.settings.data.audio
    const set = (fn: (a: typeof h.settings.data.audio) => void) => { h.settings.update((d) => fn(d.audio)); h.applyAudio() }
    const items: MenuItem[] = []
    if (p.allows('audio.mute')) items.push({ kind: 'toggle', label: 'Mute', get: () => s().muted, set: (v) => set((a) => (a.muted = v)) })
    if (p.allows('audio.master')) items.push(slider('Master', () => s().master, (v) => set((a) => (a.master = v))))
    if (p.allows('audio.engine')) items.push(slider('Engine', () => s().engine, (v) => set((a) => (a.engine = v))))
    if (p.allows('audio.sfx')) items.push(slider('Interface', () => s().sfx, (v) => set((a) => (a.sfx = v))))
    if (!items.length) items.push({ kind: 'info', label: 'Nothing to change here' })
    return { id: 'audio', title: 'Audio', items, footer: '← → adjust · Esc back' }
  }

  private controls(): MenuScreen {
    const h = this.h
    const p = h.policy
    const s = () => h.settings.data
    const items: MenuItem[] = []
    if (p.allows('controls.gamepad')) {
      items.push({
        kind: 'toggle',
        label: 'Gamepad',
        hint: h.input.gamepad.connected ? `connected: ${h.input.gamepad.glyphs}` : 'none connected — press a button on it',
        get: () => s().gamepad,
        set: (v) => { h.settings.update((d) => (d.gamepad = v)); h.applyBindings() },
      })
    }
    if (p.allows('controls.map')) {
      items.push({
        kind: 'toggle',
        label: 'Expand the map',
        hint: 'left stick click and N fill the screen. Off until you turn this on — Esc, N, or the stick closes it',
        get: () => s().mapExpand,
        set: (v) => { h.settings.update((d) => (d.mapExpand = v)); h.applyBindings() },
      })
      items.push({
        kind: 'toggle',
        label: 'Map follows heading',
        hint: 'ahead is up. Off keeps north at the top',
        get: () => s().mapHeading,
        set: (v) => { h.settings.update((d) => (d.mapHeading = v)); h.applyBindings() },
      })
    }
    if (p.allows('controls.haptics')) items.push(slider('Rumble', () => s().haptics, (v) => { h.settings.update((d) => (d.haptics = v)); h.applyBindings() }))
    if (p.allows('controls.recover')) items.push(choice('Recover also repairs', h.recover))
    if (p.allows('controls.bindings')) {
      items.push({ kind: 'info', label: 'Keyboard', value: () => 'Gamepad' })
      for (const a of ACTIONS) {
        items.push({
          kind: 'remap',
          label: ACTION_LABELS[a],
          get: () => `${(s().keys[a] ?? []).map(keyLabel).join(' / ') || '—'}   ·   ${(s().pad[a] ?? []).map(padBindingLabel).join(' / ') || '—'}`,
          onRemap: () => this.stack.push(this.remap(a)),
          onClear: () => { h.settings.update((d) => { d.keys[a] = []; d.pad[a] = [] }); h.applyBindings() },
        })
      }
    }
    if (p.allows('controls.reset')) items.push({ kind: 'action', label: 'Reset to defaults', onSelect: () => { h.settings.resetBindings(); h.applyBindings(); this.stack.refresh() } })
    if (!items.length) items.push({ kind: 'info', label: 'Nothing to change here' })
    return {
      id: 'controls',
      title: 'Controls',
      wide: true,
      items,
      footer: 'Select an action, then tap a key to set it — or hold a key to add it alongside the ones already bound. A pad button replaces the pad binding.',
    }
  }

  private remap(action: Action): MenuScreen {
    const h = this.h
    // Escape belongs to the pause menu and nothing else: bound to the throttle it would trap you.
    const escapable = action === 'pause'
    let hold = 0
    this.capturing = true
    const finish = () => {
      capture.finish()
      this.capturing = false
      h.input.swallowFrames = 2
      h.applyBindings()
      this.stack.pop()
      this.stack.refresh()
    }
    const capture = new BindingCapture(h.input.keyboard, h.input.gamepad, {
      allowEscape: escapable,
      onKey: (code, mode) => {
        h.settings.update((d) => (d.keys[action] = applyBinding(d.keys[action], code, mode)))
        finish()
      },
      onPad: (binding) => {
        h.settings.update((d) => (d.pad[action] = [binding]))
        finish()
      },
      onCancel: finish,
      onProgress: (f) => { hold = f; this.stack.refresh() },
    })
    return {
      id: 'remap',
      title: ACTION_LABELS[action],
      subtitle: 'Tap a key to set it · hold it to add a second · a pad button replaces the pad binding',
      items: [{ kind: 'info', label: escapable ? 'Escape cancels · hold Escape to bind it' : 'Escape cancels', value: () => holdMeter(hold) }],
      onBack: () => { if (!escapable || capture.finished) finish() },
    }
  }
}

function choice(label: string, c: Choice, hint?: string): MenuItem {
  return {
    kind: 'choice',
    label,
    hint,
    options: c.options.map((o) => o.label),
    get: () => Math.max(0, c.options.findIndex((o) => o.value === c.get())),
    set: (i) => c.set(c.options[i].value),
  }
}
function flag(label: string, f: Flag, hint?: string): MenuItem {
  return { kind: 'toggle', label, hint, get: () => f.get(), set: (v) => f.set(v) }
}
function slider(label: string, get: () => number, set: (v: number) => void): MenuItem {
  return { kind: 'slider', label, min: 0, max: 1, step: 0.1, get, set, format: (v) => `${Math.round(v * 100)}%` }
}
