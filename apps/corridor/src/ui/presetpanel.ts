// The presets manager: a world's named look snapshots, in the tuning panel where its knobs live.
//
// It is a tab of the tuning panel rather than a mode of its own because a preset IS the tuning
// panel's state, filtered to the world-scope knobs. Putting it somewhere else would mean two
// surfaces that show the same numbers and a person guessing which one is in force.
//
// WHAT EACH ROW OFFERS, and why those and not more. Apply is the common case. Apply-over is the
// one that matters — a preset is a keyframe, and "it becomes night over eight seconds" is the
// thing this exists for, so the duration is on the row rather than behind a menu. Update replaces
// a snapshot with what is on screen now, which is how authoring actually goes: drag knobs until
// it looks right, then press the row you were working on.
//
// AND WHAT IT SAYS ABOUT WHAT IT CANNOT DO. A preset that carries WEATHER cannot be interpolated
// through sleet-and-a-half, so the row names the knobs that will snap. An author finds that out
// here, while authoring, instead of in a cutscene.
import type { Preset, Presets } from '../presets'
import { bodyOf, empty, group, readout, textField } from './controls'
import { ask, button, confirm, el, toast } from './shell'

export interface PresetPanelOpts {
  presets: () => Presets | null
  /** the world on screen, for the file the library is written to */
  slug: () => string | null
  /** write the library back beside the bake */
  save: () => Promise<void>
  /** hand the library to the file picker / downloader */
  exportDoc: () => void
  importDoc: () => Promise<void>
  /** re-derive whatever reads the knobs; the same hook a slider drag uses */
  onChange: () => void
  /** redraw the tab, after the library changed */
  refresh: () => void
}

/** how long a tween takes, in real seconds. Remembered across rows, because authoring repeats it. */
let overSeconds = 6

export function buildPresetPanel(host: HTMLElement, o: PresetPanelOpts): void {
  const p = o.presets()
  const slug = o.slug()
  if (!p || !slug) {
    host.append(empty('Open a world first — a preset belongs to one.'))
    return
  }

  /* ---- the ground state ------------------------------------------------------------------- */
  {
    const g = group('ground state', {
      actions: [button({
        label: 'Return',
        icon: 'arrow-uturn-left',
        title: 'put every world knob back to where this world started',
        onClick: () => { p.apply(p.ground); o.onChange(); toast('back to the ground state', 'ok') },
      })],
    })
    const body = bodyOf(g)
    body.append(el('p', 'note', 'The look this world loads with, before anything you change here.'))
    body.append(readout('knobs', String(Object.keys(p.ground).length)))
    host.append(g)
  }

  /* ---- the transition in flight ----------------------------------------------------------- */
  if (p.active) {
    const g = group('transition', {
      actions: [button({ label: 'Stop', icon: 'x-mark', title: 'leave the knobs where the tween has got to', onClick: () => { p.active?.cancel(); o.refresh() } })],
    })
    const line = readout('progress', '')
    const value = line.querySelector<HTMLElement>('.field-value')!
    bodyOf(g).append(line)
    host.append(g)
    // LIVE, because a percentage frozen at whatever it was when the tab was built is worse than
    // no percentage. Self-terminating: it stops when the transition ends or the row leaves the
    // DOM, so a closed panel is not running a loop.
    const step = () => {
      const t = p.active
      if (!t || !line.isConnected) { if (line.isConnected) o.refresh(); return }
      value.textContent = `${Math.round(t.t * 100)}% of ${t.over}s`
      requestAnimationFrame(step)
    }
    step()
  }

  /* ---- how long a tween takes ------------------------------------------------------------- */
  {
    const g = group('tween', {})
    const body = bodyOf(g)
    body.append(textField({
      label: 'seconds',
      value: String(overSeconds),
      type: 'number',
      step: 1,
      onChange: (v) => { const n = Number(v); if (Number.isFinite(n) && n >= 0) overSeconds = n },
    }))
    body.append(el('p', 'note', 'How long "Tween" takes, in real seconds.'))
    host.append(g)
  }

  /* ---- the library ------------------------------------------------------------------------ */
  const list = p.list()
  const lib = group(`library (${list.length})`, {
    collapsed: false,
    actions: [
      button({ label: 'Snapshot', icon: 'camera', variant: 'primary', title: 'save what is on screen now as a new preset', onClick: () => void snapshot(p, o) }),
      button({ label: 'Import', icon: 'arrow-up-tray', title: 'read a presets file', onClick: () => void o.importDoc().then(o.refresh) }),
      button({ label: 'Export', icon: 'arrow-down-tray', title: 'download this library', onClick: () => o.exportDoc() }),
    ],
  })
  const body = bodyOf(lib)
  if (!list.length) {
    body.append(empty('No presets yet. Set the look you want with the other tabs, then press Snapshot.'))
  }
  for (const preset of list) body.append(row(preset, p, o))
  host.append(lib)

  /* ---- where it is written ---------------------------------------------------------------- */
  {
    const g = group('file', {
      actions: [button({
        label: 'Save',
        icon: 'document-arrow-down',
        variant: 'primary',
        title: `write the library to this world’s presets.json`,
        onClick: () => void o.save(),
      })],
    })
    bodyOf(g).append(readout('path', `sites/${slug}/presets.json`, true))
    host.append(g)
  }
}

function row(preset: Preset, p: Presets, o: PresetPanelOpts): HTMLElement {
  const stepped = p.stepped(preset.id)
  const n = Object.keys(preset.values).length
  const r = el('div', 'preset-row')

  const head = el('div', 'preset-head')
  head.append(el('span', 'preset-name', preset.name || preset.id))
  head.append(el('span', 'preset-count', `${n} knob${n === 1 ? '' : 's'}`))
  r.append(head)

  if (preset.note) r.append(el('p', 'note', preset.note))
  if (stepped.length) {
    // named, not hidden: a knob that snaps in a cutscene is something to know while authoring
    r.append(el('p', 'note warn', `snaps rather than tweens: ${stepped.join(', ')}`))
  }

  const acts = el('div', 'preset-acts')
  acts.append(button({
    label: 'Apply',
    icon: 'play',
    onClick: () => { p.apply(preset.id); o.onChange(); toast(`${preset.name || preset.id} applied`, 'ok') },
  }))
  acts.append(button({
    label: `Tween ${overSeconds}s`,
    icon: 'clock',
    onClick: () => {
      p.apply(preset.id, { over: overSeconds, done: () => toast(`${preset.name || preset.id} arrived`, 'ok') })
      o.refresh()
    },
  }))
  acts.append(button({
    label: 'Update',
    icon: 'arrow-path',
    title: 'replace this snapshot with what is on screen now',
    onClick: () => {
      p.snapshot(preset.id, { name: preset.name, note: preset.note })
      toast(`${preset.name || preset.id} updated from the current look`, 'ok')
      o.refresh()
    },
  }))
  acts.append(button({
    label: 'Rename',
    icon: 'pencil-square',
    variant: 'ghost',
    onClick: () => void rename(preset, p, o),
  }))
  acts.append(button({
    label: 'Delete',
    icon: 'trash',
    variant: 'ghost',
    onClick: () => void remove(preset, p, o),
  }))
  r.append(acts)
  return r
}

async function snapshot(p: Presets, o: PresetPanelOpts) {
  const name = await ask({
    title: 'Snapshot the current look',
    label: 'name',
    placeholder: 'dusk in the rain',
    icon: 'camera',
    validate: (v) => (v.trim() ? null : 'give it a name'),
  })
  if (name === null) return
  const id = slugify(name)
  if (p.get(id) && !(await confirm({ title: 'Replace it?', message: `There is already a preset called "${id}". Replace what it holds with the current look?`, ok: 'Replace' }))) return
  const snap = p.snapshot(id, { name: name.trim() })
  toast(`${name.trim()}: ${Object.keys(snap.values).length} world knobs captured`, 'ok')
  o.refresh()
}

async function rename(preset: Preset, p: Presets, o: PresetPanelOpts) {
  const name = await ask({
    title: 'Rename',
    label: 'name',
    value: preset.name || preset.id,
    icon: 'pencil-square',
    validate: (v) => (v.trim() ? null : 'give it a name'),
  })
  if (name === null) return
  // the ID is what a level and a program refer to, so renaming leaves it alone: a level that
  // names `dusk-rain` must not break because somebody fixed the capitalisation of its label
  p.put({ ...preset, name: name.trim() })
  o.refresh()
}

async function remove(preset: Preset, p: Presets, o: PresetPanelOpts) {
  const ok = await confirm({
    title: `Delete ${preset.name || preset.id}?`,
    message: 'Any level or program that names it will stop finding it. This does not change the file until you press Save.',
    ok: 'Delete',
    danger: true,
  })
  if (!ok) return
  p.remove(preset.id)
  o.refresh()
}

/** A name to an id: what a level and a program refer to, so it has to be stable and typeable. */
export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'preset'
}
