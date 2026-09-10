// Every menu screen as data, built against the live Game.

import type { Game } from '../Game'
import type { MenuItem, MenuScreen } from '@apex/engine/app/Menus'
import { BindingCapture, applyBinding, holdMeter } from '@apex/engine/app/BindingCapture'
import { ACTIONS, ACTION_LABELS, keyLabel, padBindingLabel, type Action } from '../../input/bindings'
import { COURSES } from '../../sim/track/courses/index'
import type { SimSnapshot } from '../../sim/SimSnapshot'

export function buildMenus(game: Game) {
  const s = () => game.settings.data
  const set = (fn: (d: ReturnType<typeof s>) => void) => game.settings.update(fn)

  const title = (): MenuScreen => ({
    id: 'title',
    title: 'APEX CONDUIT',
    subtitle: 'Ride the wall. Kill the traffic. Beat the clock.',
    items: [
      { kind: 'action', label: 'START CIRCUIT', hint: 'All courses back to back — score and clock carry over', onSelect: () => game.startCircuit() },
      { kind: 'action', label: 'SINGLE COURSE', hint: COURSES[game.courseIndex].name, onSelect: () => game.startRun() },
      {
        kind: 'choice',
        label: 'COURSE',
        options: COURSES.map((c) => c.name),
        get: () => game.courseIndex,
        set: (i) => {
          game.setCourse(i)
          game.world.reset(game.seed)
          game.menus.refresh()
        },
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
      { kind: 'action', label: 'RECORDS', onSelect: () => game.menus.push(records()) },
      ...(game.xr.supported
        ? [{ kind: 'action', label: 'ENTER VR', hint: 'Quest / SteamVR browser', onSelect: () => void game.xr.enter() } as MenuItem]
        : []),
      ...(game.onExit ? [{ kind: 'action', label: 'BACK TO THE ARCADE', onSelect: () => game.onExit?.() } as MenuItem] : []),
    ],
    footer: game.touch ? 'Tap to select · tilt to steer, ⟲ recalibrates · thrust/brake/fire are the side pads' : 'Enter / A to select · Esc / B to back · F3 or 0 perf overlay',
    onBack: () => game.onExit?.(),
  })

  const pause = (): MenuScreen => ({
    id: 'pause',
    title: 'PAUSED',
    items: [
      { kind: 'action', label: 'RESUME', onSelect: () => game.resume() },
      { kind: 'action', label: 'RESTART', onSelect: () => game.restart() },
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
      ...(game.xr.active ? [{ kind: 'action', label: 'EXIT VR', onSelect: () => game.xr.exit() } as MenuItem] : []),
      { kind: 'action', label: 'QUIT TO TITLE', danger: true, onSelect: () => game.quitToTitle() },
    ],
    onBack: () => game.resume(),
  })

  const settings = (): MenuScreen => ({
    id: 'settings',
    title: 'SETTINGS',
    wide: true,
    items: [
      { kind: 'action', label: 'TUNING PANEL', hint: 'F6 or T · live sliders; Copy JSON to send new defaults', onSelect: () => { game.tune.toggle(true); game.menus.refresh() } },
      { kind: 'info', label: '— MODERN —' },
      toggle('Bloom', () => s().modern.bloom, (v) => set((d) => (d.modern.bloom = v)), () => game.applyStyle()),
      toggle('Motion blur', () => s().modern.motionBlur, (v) => set((d) => (d.modern.motionBlur = v)), () => game.applyStyle()),
      toggle('Chromatic aberration', () => s().modern.chromatic, (v) => set((d) => (d.modern.chromatic = v)), () => game.applyStyle()),
      toggle('Film grain', () => s().modern.grain, (v) => set((d) => (d.modern.grain = v)), () => game.applyStyle()),
      toggle('SMAA', () => s().modern.smaa, (v) => set((d) => (d.modern.smaa = v)), () => game.applyStyle()),
      toggle('Shockwave slow-mo', () => s().modern.slowmo, (v) => set((d) => (d.modern.slowmo = v))),
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
      {
        kind: 'slider',
        label: 'Palette levels',
        min: 2,
        max: 12,
        step: 1,
        get: () => s().retro.paletteLevels,
        set: (v) => set((d) => (d.retro.paletteLevels = v)),
      },
      {
        kind: 'slider',
        label: 'Ring segments',
        min: 6,
        max: 32,
        step: 2,
        get: () => s().retro.ringSegments,
        set: (v) => {
          set((d) => (d.retro.ringSegments = v))
          game.applyStyle()
        },
      },
      {
        kind: 'action',
        label: 'Clean retro preset',
        hint: 'Low-res, flat shaded, no CRT overlay',
        onSelect: () => {
          set((d) => {
            d.retro.scanlines = false
            d.retro.barrel = false
            d.retro.phosphor = false
            d.retro.dither = false
            d.retro.presentHz = 60
          })
          game.applyStyle()
          game.menus.refresh()
        },
      },
      { kind: 'info', label: '— HANDLING —' },
      ...(game.touch ? [toggle('Invert tilt steering', () => Boolean(s().tiltInvert), (v) => set((d) => (d.tiltInvert = v)), () => game.applyAccessibility())] : []),
      {
        kind: 'slider',
        label: 'Steering speed',
        hint: '100% is the standard rate; the original game was half of it',
        min: 50,
        max: 250,
        step: 10,
        get: () => Math.round((s().steering ?? 1) * 100),
        set: (v) => {
          set((d) => (d.steering = v / 100))
          game.applyHandling()
        },
        format: (v) => `${v}%`,
      },
      { kind: 'info', label: '— AUDIO —' },
      slider('Master', () => s().audio.master, (v) => set((d) => (d.audio.master = v))),
      slider('Music', () => s().audio.music, (v) => set((d) => (d.audio.music = v))),
      slider('SFX', () => s().audio.sfx, (v) => set((d) => (d.audio.sfx = v))),
      slider('Engine', () => s().audio.engine, (v) => set((d) => (d.audio.engine = v))),
      { kind: 'info', label: '— FEEL & ACCESS —' },
      slider('Visual speed intensity', () => s().visualSpeedGain, (v) => set((d) => (d.visualSpeedGain = v)), 0, 1.5),
      toggle('Reduced motion', () => s().access.reducedMotion, (v) => set((d) => (d.access.reducedMotion = v))),
      {
        kind: 'choice',
        label: 'Colour vision',
        options: ['Default', 'Deuteranopia', 'Protanopia', 'Tritanopia'],
        get: () => ['none', 'deuteranopia', 'protanopia', 'tritanopia'].indexOf(s().access.colorblind),
        set: (i) => set((d) => (d.access.colorblind = ['none', 'deuteranopia', 'protanopia', 'tritanopia'][i] as typeof d.access.colorblind)),
      },
      slider('HUD scale', () => s().access.hudScale, (v) => set((d) => (d.access.hudScale = v)), 0.7, 1.6),
      { kind: 'info', label: '— VR —' },
      {
        kind: 'choice',
        label: 'Comfort preset',
        hint: 'Maximum also lowers top speed and widens auto-aim',
        options: ['Intense', 'Standard', 'Maximum comfort'],
        get: () => ['intense', 'standard', 'maximum'].indexOf(s().vr.comfort),
        set: (i) => set((d) => (d.vr.comfort = ['intense', 'standard', 'maximum'][i] as typeof d.vr.comfort)),
      },
      slider('VR roll follow', () => s().vr.rollBlend, (v) => set((d) => (d.vr.rollBlend = v)), 0, 1),
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

  const records = (): MenuScreen => {
    const circuit = game.records.list('circuit')
    const list = game.records.list(COURSES[game.courseIndex].id)
    return {
      id: 'records',
      title: 'RECORDS',
      subtitle: `Circuit · ${COURSES[game.courseIndex].name}`,
      wide: true,
      items: [
        { kind: 'info', label: '— CIRCUIT —' },
        ...(circuit.length
          ? circuit.slice(0, 5).map(
              (r, i): MenuItem => ({
                kind: 'info',
                label: `${i + 1}. ${r.name}  ${r.finished ? '✓' : ''}`,
                value: () => `${r.score.toLocaleString()} pts · ${r.kills} kills · ${r.gates} gates`,
              }),
            )
          : [{ kind: 'info', label: 'No circuit runs yet.' } as MenuItem]),
        { kind: 'info', label: `— ${COURSES[game.courseIndex].name.toUpperCase()} —` },
        ...(list.length
          ? list.map(
              (r, i): MenuItem => ({
                kind: 'info',
                label: `${i + 1}. ${r.name}  ${r.finished ? '✓' : ''}`,
                value: () => `${r.score.toLocaleString()} pts · ${r.kills} kills · ${r.gates} gates · ${r.distance} m`,
              }),
            )
          : [{ kind: 'info', label: 'No runs yet.' } as MenuItem]),
        {
          kind: 'action',
          label: 'Clear records',
          danger: true,
          onSelect: () => {
            game.records.clear()
            game.menus.pop()
            game.menus.push(records())
          },
        },
      ],
    }
  }

  const summary = (snap: SimSnapshot, rank: number, isBest: boolean): MenuScreen => {
    const outcome = snap.phase === 'finished' ? 'COURSE COMPLETE' : snap.phase === 'timeout' ? 'OUT OF TIME' : 'WRECKED'
    return {
      id: 'summary',
      title: outcome,
      subtitle: isBest ? (game.circuit ? 'NEW BEST CIRCUIT' : 'NEW BEST — your ghost will race you next time') : rank > 0 ? `Rank #${rank}` : '',
      items: [
        { kind: 'info', label: 'Score', value: () => snap.hud.score.toLocaleString() },
        { kind: 'info', label: 'Kills', value: () => String(snap.hud.kills) },
        { kind: 'info', label: 'Gates', value: () => `${snap.hud.gatesPassed} / ${snap.hud.gatesTotal}` },
        { kind: 'info', label: 'Distance', value: () => `${Math.round(snap.vehicle.s).toLocaleString()} m` },
        { kind: 'info', label: 'Time', value: () => `${snap.time.toFixed(1)} s` },
        { kind: 'action', label: 'RETRY', onSelect: () => game.restart() },
        { kind: 'action', label: 'TITLE', onSelect: () => game.quitToTitle() },
      ],
      onBack: () => game.quitToTitle(),
    }
  }

  return { title, pause, settings, controls, records, summary }
}

function toggle(label: string, get: () => boolean, setV: (v: boolean) => void, after?: () => void): MenuItem {
  return {
    kind: 'toggle',
    label,
    get,
    set: (v) => {
      setV(v)
      after?.()
    },
  }
}

function slider(label: string, get: () => number, setV: (v: number) => void, min = 0, max = 1): MenuItem {
  return {
    kind: 'slider',
    label,
    min,
    max,
    step: 0.1,
    get,
    set: setV,
    format: (v) => `${Math.round(v * 100)}%`,
  }
}
