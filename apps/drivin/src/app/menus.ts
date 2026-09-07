// Menu screens for the driving game, built against the live Game.

import type { MenuItem, MenuScreen } from '@apex/engine/app/Menus'
import { keyLabel, padBindingLabel } from '@apex/engine/input/bindings'
import { CARS } from '../sim/CarSpec'
import { ACTIONS, ACTION_LABELS, type Action } from '../input/bindings'
import type { Game } from './Game'
import { fmtTime } from './Hud'
import type { Snapshot } from '../sim/Snapshot'

export function buildMenus(game: Game) {
  const s = () => game.settings.data
  const set = (fn: (d: ReturnType<typeof s>) => void) => game.settings.update(fn)
  const LAPS = [1, 3, 5, 0]

  const title = (): MenuScreen => {
    const tracks = game.tracks.list()
    const ti = Math.max(0, tracks.findIndex((t) => t.id === s().trackId))
    return {
      id: 'title',
      title: 'HARD LINE',
      subtitle: 'Stunt-track driving · working title',
      items: [
        { kind: 'action', label: 'DRIVE', hint: tracks[ti]?.name ?? '', onSelect: () => game.startDrive() },
        {
          kind: 'choice',
          label: 'TRACK',
          options: tracks.map((t) => (t.builtin ? '★ ' : '') + t.name),
          get: () => Math.max(0, tracks.findIndex((t) => t.id === s().trackId)),
          set: (i) => {
            set((d) => (d.trackId = tracks[i].id))
            game.previewTrack()
            game.menus.refresh()
          },
        },
        { kind: 'choice', label: 'LAPS', options: ['1', '3', '5', 'Free run'], get: () => Math.max(0, LAPS.indexOf(s().laps)), set: (i) => set((d) => (d.laps = LAPS[i])) },
        { kind: 'choice', label: 'CAR', options: CARS.map((c) => c.name), get: () => Math.max(0, CARS.findIndex((c) => c.id === s().carId)), set: (i) => set((d) => (d.carId = CARS[i].id)) },
        { kind: 'action', label: 'TRACK EDITOR', hint: 'Build your own on the grid', onSelect: () => game.openEditor() },
        {
          kind: 'choice',
          label: 'STYLE',
          hint: 'F2 toggles any time',
          options: ['MODERN', 'RETRO'],
          get: () => (s().style === 'retro' ? 1 : 0),
          set: (i) => {
            set((d) => (d.style = i === 1 ? 'retro' : 'modern'))
            game.applyStyle()
          },
        },
        { kind: 'action', label: 'SETTINGS', onSelect: () => game.menus.push(settings()) },
        { kind: 'action', label: 'CONTROLS', onSelect: () => game.menus.push(controls()) },
      ],
      footer: game.touch ? 'Tap to select · tilt to steer, ⟲ recalibrates · GAS right thumb, BRAKE left' : 'Enter / A select · Esc / B back · F3 perf',
      onBack: () => {},
    }
  }

  const pause = (): MenuScreen => ({
    id: 'pause',
    title: 'PAUSED',
    items: [
      { kind: 'action', label: 'RESUME', onSelect: () => game.resume() },
      { kind: 'action', label: 'RESTART', onSelect: () => game.restart() },
      { kind: 'choice', label: 'CAMERA', options: ['CHASE', 'HOOD'], get: () => (s().camera === 'hood' ? 1 : 0), set: (i) => { set((d) => (d.camera = i === 1 ? 'hood' : 'chase')); game.applyCamera() } },
      {
        kind: 'choice',
        label: 'STYLE',
        options: ['MODERN', 'RETRO'],
        get: () => (s().style === 'retro' ? 1 : 0),
        set: (i) => {
          set((d) => (d.style = i === 1 ? 'retro' : 'modern'))
          game.applyStyle()
        },
      },
      { kind: 'action', label: 'SETTINGS', onSelect: () => game.menus.push(settings()) },
      { kind: 'action', label: 'CONTROLS', onSelect: () => game.menus.push(controls()) },
      ...(game.fromEditor ? [{ kind: 'action', label: 'BACK TO EDITOR', onSelect: () => game.openEditor() } as MenuItem] : []),
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
        options: ['320×240', '400×300', '512×384', '640×480'],
        get: () => [320, 400, 512, 640].indexOf(s().retro.width),
        set: (i) => {
          set((d) => {
            d.retro.width = [320, 400, 512, 640][i]
            d.retro.height = [240, 300, 384, 480][i]
          })
          game.applyStyle()
        },
      },
      {
        kind: 'choice',
        label: 'Present rate',
        hint: 'Sim and input stay at 120 Hz regardless',
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
      toggle('Vertex snapping', () => s().retro.quantizeVerts, (v) => set((d) => (d.retro.quantizeVerts = v)), () => game.applyStyle()),
      { kind: 'slider', label: 'Palette levels', min: 2, max: 12, step: 1, get: () => s().retro.paletteLevels, set: (v) => set((d) => (d.retro.paletteLevels = v)) },
      { kind: 'info', label: '— GAME —' },
      { kind: 'choice', label: 'Units', options: ['MPH', 'KM/H'], get: () => (s().units === 'kmh' ? 1 : 0), set: (i) => { set((d) => (d.units = i === 1 ? 'kmh' : 'mph')); game.hud.units = s().units } },
      { kind: 'choice', label: 'Camera', options: ['Chase', 'Hood'], get: () => (s().camera === 'hood' ? 1 : 0), set: (i) => { set((d) => (d.camera = i === 1 ? 'hood' : 'chase')); game.applyCamera() } },
      { kind: 'info', label: '— AUDIO —' },
      slider('Master', () => s().audio.master, (v) => set((d) => (d.audio.master = v))),
      slider('SFX', () => s().audio.sfx, (v) => set((d) => (d.audio.sfx = v))),
      slider('Engine', () => s().audio.engine, (v) => set((d) => (d.audio.engine = v))),
      slider('Haptics (rumble / triggers / phone)', () => s().haptics, (v) => set((d) => (d.haptics = v))),
      { kind: 'info', label: '— ACCESS —' },
      toggle('Reduced motion', () => s().access.reducedMotion, (v) => set((d) => (d.access.reducedMotion = v))),
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
          onClear: () => set((d) => {
            d.keys[a] = []
            d.pad[a] = []
          }),
        }),
      ),
      {
        kind: 'action',
        label: 'Reset to defaults',
        onSelect: () => {
          game.settings.resetBindings()
          game.input.keys = s().keys
          game.input.pad = s().pad
          game.menus.refresh()
        },
      },
    ],
    footer: 'Select an action, then press the new key or button. Escape cancels.',
  })

  const remap = (action: Action): MenuScreen => {
    const finish = () => {
      game.input.keyboard.onAny = null
      game.input.gamepad.onAny = null
      game.input.swallowFrames = 2
      game.input.keys = s().keys
      game.input.pad = s().pad
      game.menus.pop()
      game.menus.refresh()
    }
    game.input.keyboard.onAny = (code) => {
      if (code === 'Escape') return finish()
      set((d) => (d.keys[action] = [code]))
      finish()
    }
    game.input.gamepad.onAny = (binding) => {
      set((d) => (d.pad[action] = [binding]))
      finish()
    }
    return { id: 'remap', title: ACTION_LABELS[action].toUpperCase(), subtitle: 'Press a key or gamepad button…', items: [{ kind: 'info', label: 'Escape to cancel' }], onBack: finish }
  }

  const results = (snap: Snapshot): MenuScreen => ({
    id: 'results',
    title: 'FINISHED',
    subtitle: game.currentTrackName,
    items: [
      { kind: 'info', label: 'Best lap', value: () => fmtTime(snap.hud.bestLap) },
      { kind: 'info', label: 'Last lap', value: () => fmtTime(snap.hud.lastLap) },
      { kind: 'info', label: 'Total', value: () => fmtTime(snap.time) },
      { kind: 'info', label: 'Crashes', value: () => String(snap.hud.crashes) },
      { kind: 'action', label: 'RETRY', onSelect: () => game.restart() },
      ...(game.fromEditor ? [{ kind: 'action', label: 'BACK TO EDITOR', onSelect: () => game.openEditor() } as MenuItem] : []),
      { kind: 'action', label: 'TITLE', onSelect: () => game.quitToTitle() },
    ],
    onBack: () => game.quitToTitle(),
  })

  return { title, pause, settings, controls, results }
}

function toggle(label: string, get: () => boolean, setV: (v: boolean) => void, after?: () => void): MenuItem {
  return { kind: 'toggle', label, get, set: (v) => { setV(v); after?.() } }
}

function slider(label: string, get: () => number, setV: (v: number) => void, min = 0, max = 1): MenuItem {
  return { kind: 'slider', label, min, max, step: 0.1, get, set: setV, format: (v) => `‹ ${Math.round(v * 100)}% ›` }
}
