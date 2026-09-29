// Settings → Services: every external service this editor and the asset service reach, editable.
//
// Rich, 2026-09-29: "We need to make sure all services are configurable both from env vars and
// from within the editor's UI, so we should be able to configure trellis endpoint, image generator
// endpoint, and the splat pipeline."
//
// EVERY ROW SAYS WHERE ITS VALUE CAME FROM. "from the UI", "from the environment", or "default" —
// because when the image generator will not answer, the first question is whether that URL was
// typed by a person last week or rendered by the chart this morning, and a bare text box cannot
// say. A row saved from the UI also says what clearing it would fall back to, so "reset" is a
// decision somebody can make knowing what they get.
//
// SAVE IS PER SERVICE, and all-or-nothing. Both services refuse a patch with any invalid value in
// it rather than applying half, so the panel sends only the rows that changed and shows the
// refusal's own sentence when it comes back.
import { button, el, toast } from '../ui/shell'
import { bodyOf, group, readout, select, textField } from '../ui/controls'
import { icon } from '../ui/icons'
import { api, type SettingRow } from './api'

const SOURCE: Record<SettingRow['source'], string> = {
  ui: 'set here',
  env: 'from the environment',
  default: 'default',
}

const GROUP: Record<string, string> = {
  services: 'Services this editor reaches',
  bake: 'The bake',
  splat: 'Splat training',
  blender: 'Blender (rigging)',
  image: 'Image generator',
  mesh: 'Mesh reconstructor (TRELLIS)',
}

interface Section {
  title: string
  load: () => Promise<{ settings: SettingRow[] }>
  save: (patch: Record<string, string | null>) => Promise<{ settings: SettingRow[] }>
}

export function buildSettings(host: HTMLElement): void {
  host.replaceChildren()
  const sections: Section[] = [
    { title: 'World editor', load: api.settings, save: api.putSettings },
    // the asset service owns the generator and TRELLIS endpoints, because it is what calls them
    { title: 'Asset service', load: api.assetSettings, save: api.putAssetSettings },
  ]
  for (const sec of sections) {
    const holder = el('div', 'settings-section')
    host.append(holder)
    void drawSection(holder, sec)
  }
}

async function drawSection(host: HTMLElement, sec: Section): Promise<void> {
  host.replaceChildren(el('p', 'dim', `${sec.title}: reading…`))
  let rows: SettingRow[]
  try {
    rows = (await sec.load()).settings
  } catch (e) {
    // the asset service is optional and may be down; that is a state to show, not a crash
    host.replaceChildren()
    const g = group(sec.title, { collapsed: false })
    bodyOf(g).append(el('p', 'panel-hint', `${sec.title} did not answer — ${(e as Error).message}`))
    host.append(g)
    return
  }

  // what the person has typed but not saved, keyed by setting
  const draft = new Map<string, string | null>()
  host.replaceChildren()

  const groups = new Map<string, SettingRow[]>()
  for (const r of rows) groups.set(r.group, [...(groups.get(r.group) ?? []), r])

  const saveBtn = button({
    label: 'Save',
    icon: 'document-arrow-down',
    variant: 'primary',
    disabled: true,
    onClick: async () => {
      const patch = Object.fromEntries(draft)
      try {
        await sec.save(patch)
        toast(`${sec.title}: saved ${draft.size} setting${draft.size === 1 ? '' : 's'}`, 'ok')
        await drawSection(host, sec)
      } catch (e) {
        // the service's own sentence, which names the value it refused
        toast(`${sec.title}: ${(e as Error).message}`, 'danger', 9000)
      }
    },
  })
  const touched = () => { saveBtn.disabled = draft.size === 0 }

  for (const [g, list] of groups) {
    const box = group(`${sec.title} — ${GROUP[g] ?? g}`, { collapsed: false })
    const b = bodyOf(box)
    for (const r of list) b.append(row(r, draft, touched, () => void drawSection(host, sec), sec))
    host.append(box)
  }
  const acts = el('div', 'panel-actions')
  acts.append(saveBtn)
  host.append(acts)
}

function row(
  r: SettingRow,
  draft: Map<string, string | null>,
  touched: () => void,
  redraw: () => void,
  sec: Section,
): HTMLElement {
  const wrap = el('div', 'setting-row')
  const set = (v: string) => {
    if (v === r.value) draft.delete(r.key)
    else draft.set(r.key, v)
    touched()
  }

  let control: HTMLElement
  if (r.kind === 'enum' && r.options?.length) {
    control = select({
      label: r.label,
      value: r.value,
      options: r.options.map((o) => ({ value: o, label: o })),
      onChange: set,
    })
  } else if (r.kind === 'bool') {
    control = select({
      label: r.label,
      value: r.value === 'true' ? 'true' : 'false',
      options: [{ value: 'true', label: 'on' }, { value: 'false', label: 'off' }],
      onChange: set,
    })
  } else {
    control = textField({
      label: r.label,
      value: r.value,
      placeholder: r.kind === 'json' ? '["a", "b"]' : r.kind === 'url' ? 'http://…' : '',
      note: r.note ?? undefined,
      onChange: set,
    })
  }
  wrap.append(control)

  const meta = el('div', 'setting-meta')
  const badge = el('span', `setting-source source-${r.source}`, SOURCE[r.source])
  meta.append(badge)
  if (r.env) meta.append(el('span', 'mono dim', r.env))
  if (r.source === 'ui') {
    // RESET means "back to what the deployment said" — named, so it is not a guess
    meta.append(button({
      label: `Reset to ${r.fallback ? (r.fallback.length > 32 ? `${r.fallback.slice(0, 32)}…` : r.fallback) : 'the default'}`,
      icon: 'arrow-path',
      variant: 'ghost',
      onClick: async () => {
        try {
          await sec.save({ [r.key]: null })
          toast(`${r.label}: back to ${r.fallback ? 'the environment' : 'the default'}`, 'ok')
          redraw()
        } catch (e) {
          toast((e as Error).message, 'danger')
        }
      },
    }))
  }
  wrap.append(meta)
  if (r.kind !== 'url' && r.kind !== 'string' && r.kind !== 'json' && r.note) {
    wrap.append(el('p', 'dim setting-note', r.note))
  }
  return wrap
}

/** For the Services tab: what the editor is pointed at, read-only, beside the editable settings. */
export async function buildReach(host: HTMLElement): Promise<void> {
  const [r, c] = await Promise.all([api.ready().catch(() => null), api.config().catch(() => null)])
  const g = group('Reachable right now', { collapsed: false })
  const b = bodyOf(g)
  // what the old readout showed and a setting does not: where worlds live, and how a bake runs
  b.append(readout('data', c?.data ?? '?'))
  b.append(readout('bake runner', `${c?.runs.runner ?? '?'}${c?.runs.runner === 'kubernetes' ? ` · ${c?.runs.namespace}` : ''}`))
  b.append(readout('bucket', c?.bucket ? `${c.bucket.bucket}/${c.bucket.prefix}` : 'not configured'))
  b.append(readout('overpass', r?.overpass.ok ? `up (${r.overpass.ms} ms)` : `DOWN — ${r?.overpass.detail?.slice(0, 100) ?? 'no answer'}`))
  b.append(readout('kubernetes', r?.kubernetes.ok ? `ok (${r.kubernetes.namespace})` : r?.kubernetes.detail ?? '?'))
  b.append(readout('assetsvc', r?.assetsvc ?? 'not configured'))
  const hint = el('p', 'panel-hint')
  hint.append(icon('information-circle', 14), el('span', '', 'Saved values win over the environment; Reset returns a setting to what the deployment said.'))
  b.append(hint)
  host.append(g)
}
