import type { MenuItem, MenuScreen } from '@apex/engine/app/Menus'
import { BindingCapture, applyBinding, holdMeter } from '@apex/engine/app/BindingCapture'
import { keyLabel, padBindingLabel } from '@apex/engine/input/bindings'
import { STATIONS } from '../audio/AudioWorld'
import { LIVERIES } from '../render/procgen'
import { ACTIONS, ACTION_LABELS, type Action } from '../input/bindings'
import type { Snapshot } from '../sim/Snapshot'
import type { Game } from './Game'

export function buildMenus(game: Game) {
  const s = () => game.settings.data
  const set = (fn: (d: ReturnType<typeof s>) => void) => game.settings.update(fn)
  const worlds = () => game.worlds.list()
  /**
   * START AT lists the stages of whichever world is selected, and the menu re-reads this
   * array on every render — so switching world refills it in place rather than rebuilding
   * the screen, which would bounce the cursor back to START.
   */
  const startOptions: string[] = []
  const refreshStartOptions = () => {
    startOptions.length = 0
    for (const id of game.route.ids) startOptions.push(`${id} · ${game.route.name(id)}`)
  }
  refreshStartOptions()

  const title = (): MenuScreen => ({
    id: 'title',
    title: 'TURBO RADRUN',
    subtitle: 'Coast to coast · or a world of your own · one clock',
    items: [
      { kind: 'action', label: 'START', onSelect: () => game.startRun() },
      ...(game.fromEditor ? [{ kind: 'action' as const, label: 'BACK TO THE EDITOR', hint: 'Your work is still there', onSelect: () => game.openEditor() }] : []),
      {
        kind: 'choice',
        label: 'WORLD',
        hint: 'The built-in route, or one you built',
        options: worlds().map((w) => w.name),
        get: () => Math.max(0, worlds().findIndex((w) => w.id === (s().world ?? 'builtin'))),
        set: (i) => {
          set((d) => (d.world = worlds()[i].id))
          game.applyWorld()
          refreshStartOptions()
        },
      },
      {
        kind: 'choice',
        label: 'START AT',
        hint: 'Begin the run on any stage',
        options: startOptions,
        get: () => Math.max(0, game.route.ids.indexOf(s().startStage)),
        set: (i) => set((d) => (d.startStage = game.route.ids[i])),
      },
      { kind: 'action', label: 'BUILD A WORLD', hint: 'Lay out your own tracks and drive them', onSelect: () => game.openEditor() },
      {
        kind: 'choice',
        label: 'RADIO',
        hint: 'Tune the station before you go',
        options: STATIONS.map((st) => st.name),
        get: () => s().station,
        set: (i) => {
          set((d) => (d.station = i))
          game.applyStation()
        },
      },
      { kind: 'choice', label: 'VIEW', hint: 'C / Y switches while driving', options: ['CHASE', 'COCKPIT'], get: () => (s().view === 'cockpit' ? 1 : 0), set: (i) => { set((d) => (d.view = i === 1 ? 'cockpit' : 'chase')); game.applyView() } },
      { kind: 'choice', label: 'GEARBOX', hint: 'Two speeds. Manual shifts on Shift; automatic shifts for you but gives up some top speed', options: ['MANUAL', 'AUTOMATIC'], get: () => (s().gearbox === 'auto' ? 1 : 0), set: (i) => { set((d) => (d.gearbox = i === 1 ? 'auto' : 'manual')); game.applyGearbox() } },
      {
        kind: 'choice',
        label: 'CAR',
        options: [...Object.keys(LIVERIES).map((k) => `Prototype · ${k}`), 'Formula'],
        get: () => { const keys = [...Object.keys(LIVERIES), 'formula']; return Math.max(0, keys.indexOf(s().car)) },
        set: (i) => { const keys = [...Object.keys(LIVERIES), 'formula']; set((d) => (d.car = keys[i])); game.applyCar() },
      },
      {
        kind: 'choice',
        label: 'STYLE',
        hint: 'F2 or ` toggles any time',
        options: ['MODERN', 'RETRO'],
        get: () => (s().style === 'retro' ? 1 : 0),
        set: (i) => {
          set((d) => (d.style = i === 1 ? 'retro' : 'modern'))
          game.applyStyle()
        },
      },
      { kind: 'action', label: 'SETTINGS', onSelect: () => game.menus.push(settings()) },
      { kind: 'action', label: 'CONTROLS', onSelect: () => game.menus.push(controls()) },
      ...(game.onExit ? [{ kind: 'action', label: 'BACK TO THE ARCADE', onSelect: () => game.onExit?.() } as MenuItem] : []),
    ],
    footer: game.touch ? 'Tap to select · tilt to steer · GAS right, BRAKE left' : 'Enter / A select · Shift = gear · C = view · F3 or 0 perf',
    onBack: () => game.onExit?.(),
  })

  const pause = (): MenuScreen => ({
    id: 'pause',
    title: 'PAUSED',
    items: [
      { kind: 'action', label: 'RESUME', onSelect: () => game.resume() },
      { kind: 'action', label: 'RESTART', onSelect: () => game.restart() },
      ...(game.fromEditor ? [{ kind: 'action' as const, label: 'BACK TO THE EDITOR', onSelect: () => game.openEditor() }] : []),
      { kind: 'choice', label: 'VIEW', options: ['CHASE', 'COCKPIT'], get: () => (s().view === 'cockpit' ? 1 : 0), set: (i) => { set((d) => (d.view = i === 1 ? 'cockpit' : 'chase')); game.applyView() } },
      { kind: 'choice', label: 'RADIO', options: STATIONS.map((st) => st.name), get: () => s().station, set: (i) => { set((d) => (d.station = i)); game.applyStation() } },
      { kind: 'choice', label: 'STYLE', options: ['MODERN', 'RETRO'], get: () => (s().style === 'retro' ? 1 : 0), set: (i) => { set((d) => (d.style = i === 1 ? 'retro' : 'modern')); game.applyStyle() } },
      { kind: 'action', label: 'SETTINGS', onSelect: () => game.menus.push(settings()) },
      { kind: 'action', label: 'CONTROLS', onSelect: () => game.menus.push(controls()) },
      { kind: 'action', label: 'QUIT TO TITLE', danger: true, onSelect: () => game.quitToTitle() },
    ],
    onBack: () => game.resume(),
  })

  const settings = (): MenuScreen => ({
    id: 'settings',
    title: 'SETTINGS',
    wide: true,
    items: [
      { kind: 'info', label: '— MODERN —' },
      toggle('Bloom', () => s().modern.bloom, (v) => set((d) => (d.modern.bloom = v)), () => game.applyStyle()),
      toggle('Motion blur', () => s().modern.motionBlur, (v) => set((d) => (d.modern.motionBlur = v)), () => game.applyStyle()),
      toggle('Chromatic aberration', () => s().modern.chromatic, (v) => set((d) => (d.modern.chromatic = v)), () => game.applyStyle()),
      toggle('Film grain', () => s().modern.grain, (v) => set((d) => (d.modern.grain = v)), () => game.applyStyle()),
      toggle('SMAA', () => s().modern.smaa, (v) => set((d) => (d.modern.smaa = v)), () => game.applyStyle()),
      { kind: 'info', label: '— RETRO —' },
      {
        kind: 'choice',
        label: 'Internal resolution',
        hint: '320×224 is OutRun; 416×224 the System 32 boards',
        options: ['320 × 224', '416 × 224', '512 × 288', '640 × 360'],
        get: () => Math.max(0, [320, 416, 512, 640].indexOf(s().retro.width)),
        set: (i) => {
          set((d) => {
            d.retro.width = [320, 416, 512, 640][i]
            d.retro.height = [224, 224, 288, 360][i]
          })
          game.applyStyle()
        },
      },
      {
        kind: 'choice',
        label: 'Present rate',
        options: ['20 Hz', '30 Hz', '60 Hz', 'Uncapped'],
        get: () => [20, 30, 60, 0].indexOf(s().retro.presentHz),
        set: (i) => {
          set((d) => (d.retro.presentHz = [20, 30, 60, 0][i] as 20 | 30 | 60 | 0))
          game.applyStyle()
        },
      },
      toggle('Scanlines', () => s().retro.scanlines, (v) => set((d) => (d.retro.scanlines = v))),
      toggle('Barrel distortion', () => s().retro.barrel, (v) => set((d) => (d.retro.barrel = v))),
      toggle('Dithering', () => s().retro.dither, (v) => set((d) => (d.retro.dither = v))),
      toggle('Phosphor bleed', () => s().retro.phosphor, (v) => set((d) => (d.retro.phosphor = v))),
      { kind: 'slider', label: 'Palette levels', min: 2, max: 12, step: 1, get: () => s().retro.paletteLevels, set: (v) => set((d) => (d.retro.paletteLevels = v)) },
      { kind: 'info', label: '— GAME —' },
      { kind: 'action', label: 'TUNING PANEL', hint: 'F6 or T · live sliders; Copy JSON to send new defaults', onSelect: () => { game.tune.toggle(true); game.menus.refresh() } },
      { kind: 'choice', label: 'Units', options: ['KM/H', 'MPH'], get: () => (s().units === 'mph' ? 1 : 0), set: (i) => { set((d) => (d.units = i === 1 ? 'mph' : 'kmh')); game.hud.units = s().units } },
      { kind: 'info', label: '— AUDIO —' },
      slider('Master', () => s().audio.master, (v) => set((d) => (d.audio.master = v))),
      slider('Radio', () => s().audio.music, (v) => set((d) => (d.audio.music = v))),
      slider('SFX', () => s().audio.sfx, (v) => set((d) => (d.audio.sfx = v))),
      slider('Engine', () => s().audio.engine, (v) => set((d) => (d.audio.engine = v))),
      slider('Haptics', () => s().haptics, (v) => set((d) => (d.haptics = v))),
      { kind: 'info', label: '— ACCESS —' },
      toggle('Reduced motion', () => s().access.reducedMotion, (v) => set((d) => (d.access.reducedMotion = v))),
      ...(game.touch ? [toggle('Invert tilt steering', () => Boolean(s().tiltInvert), (v) => set((d) => (d.tiltInvert = v)), () => game.applyAccessibility())] : []),
      slider('HUD scale', () => s().access.hudScale, (v) => set((d) => (d.access.hudScale = v)), 0.7, 1.6),
    ],
    footer: '← → adjust · Esc back',
  })

  const controls = (): MenuScreen => ({
    id: 'controls',
    title: 'CONTROLS',
    wide: true,
    items: [
      { kind: 'info', label: 'Keyboard', value: () => 'Gamepad' },
      ...ACTIONS.map(
        (a): MenuItem => ({
          kind: 'remap',
          label: ACTION_LABELS[a],
          get: () => `${(s().keys[a] ?? []).map(keyLabel).join(' / ') || '—'}   ·   ${(s().pad[a] ?? []).map(padBindingLabel).join(' / ') || '—'}`,
          onRemap: () => game.menus.push(remap(a)),
          onClear: () => set((d) => { d.keys[a] = []; d.pad[a] = [] }),
        }),
      ),
      { kind: 'action', label: 'Reset to defaults', onSelect: () => { game.settings.resetBindings(); game.input.keys = s().keys; game.input.pad = s().pad; game.menus.refresh() } },
    ],
    footer: 'Select an action, then tap a key to set it — or hold a key to add it alongside the ones already bound.',
  })

  const remap = (action: Action): MenuScreen => {
    // Escape belongs to pause and nothing else: bound to the throttle it would trap you in the game.
    const escapable = action === 'pause'
    let hold = 0
    const finish = () => {
      capture.finish()
      game.input.swallowFrames = 2
      game.input.keys = s().keys
      game.input.pad = s().pad
      game.menus.pop()
      game.menus.refresh()
    }
    const capture = new BindingCapture(game.input.keyboard, game.input.gamepad, {
      allowEscape: escapable,
      onKey: (code, mode) => {
        set((d) => (d.keys[action] = applyBinding(d.keys[action], code, mode)))
        finish()
      },
      onPad: (binding) => {
        set((d) => (d.pad[action] = [binding]))
        finish()
      },
      onCancel: finish,
      onProgress: (f) => {
        hold = f
        game.menus.refresh()
      },
    })
    return {
      id: 'remap',
      title: ACTION_LABELS[action].toUpperCase(),
      subtitle: 'Tap a key to set it · hold it to add a second',
      items: [{ kind: 'info', label: escapable ? 'Escape cancels · hold Escape to bind it' : 'Escape cancels', value: () => holdMeter(hold) }],
      // When Escape can be bound the capture owns it: a tap cancels in there, a hold binds it.
      onBack: () => {
        if (!escapable || capture.finished) finish()
      },
    }
  }

  const results = (snap: Snapshot): MenuScreen => {
    const finished = snap.phase === 'finished'
    const route = snap.hud.route.split(' › ').map((id) => game.route.name(id))
    return {
      id: 'results',
      title: finished ? 'GOAL' : 'TIME UP',
      subtitle: route.join(' → '),
      items: [
        { kind: 'info', label: 'Score', value: () => snap.hud.score.toLocaleString() },
        { kind: 'info', label: 'Stage reached', value: () => `${snap.hud.stage} / ${snap.hud.stagesTotal}` },
        { kind: 'info', label: 'Time', value: () => `${snap.time.toFixed(1)} s` },
        { kind: 'info', label: 'World', value: () => game.route.worldName },
        { kind: 'action', label: 'AGAIN', onSelect: () => game.restart() },
        ...(game.fromEditor ? [{ kind: 'action' as const, label: 'BACK TO THE EDITOR', onSelect: () => game.openEditor() }] : []),
        { kind: 'action', label: 'TITLE', onSelect: () => game.quitToTitle() },
      ],
      onBack: () => game.quitToTitle(),
    }
  }

  return { title, pause, settings, controls, results }
}

function toggle(label: string, get: () => boolean, setV: (v: boolean) => void, after?: () => void): MenuItem {
  return { kind: 'toggle', label, get, set: (v) => { setV(v); after?.() } }
}
function slider(label: string, get: () => number, setV: (v: number) => void, min = 0, max = 1): MenuItem {
  return { kind: 'slider', label, min, max, step: 0.1, get, set: setV, format: (v) => `${Math.round(v * 100)}%` }
}
