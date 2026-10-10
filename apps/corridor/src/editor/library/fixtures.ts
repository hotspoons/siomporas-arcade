// The asset manager's Fixtures tab: what the world wears for each class of built-in thing.
//
// Rich, 2026-09-30: *"we need to be able to add to and manage these types of assets, and use
// different variants in our levels … if there are any settings that we'd want per placed asset,
// put them in this new asset manager area."* Each class here is a row: the built-in or a catalog
// asset of that class as the variant, and the class's settings under it. Saving writes the
// world's fixtures.json; the viewer applies it live, the editor on its next preview.

import { el, button, toast, type Tab } from '../../ui/shell'
import { group, bodyOf, select, slider, toggle } from '../../ui/controls'
import type { AssetExtension } from './assets'
import { assetsvc, type AssetItem } from '../../assets/assetsvc'
import { FIXTURES, settingsOf, type FixtureChoice, type FixtureDoc } from '../../game/world/fixtures'

export interface FixturesExtensionOpts {
  /** the world whose fixtures are being edited, or null when none is open */
  slug: () => string | null
  /** the document as it stands (the viewer's live one, or the file) */
  current: () => Promise<FixtureDoc>
  /** write it, and apply it where that is possible */
  save: (doc: FixtureDoc) => Promise<void>
}

export function fixturesExtension(o: FixturesExtensionOpts): AssetExtension {
  const tab: Tab = {
    id: 'fixtures',
    label: 'Fixtures',
    icon: 'rectangle-group',
    build: (host) => void build(host, o),
  }
  return { tabs: [tab] }
}

async function build(panel: HTMLElement, o: FixturesExtensionOpts) {
  /*
   * THE TAB SCROLLS, and Save stays put under it. Rich, 2026-10-10: "Materials and fixtures don't
   * scroll." Eleven classes of groups is three screens, and in the world editor's pane the panel
   * clips rather than scrolls — so the groups go in a scroller of their own and Save sits in the
   * foot, reachable without scrolling to the end (buildscreen.css, `.lib-screen`).
   */
  panel.replaceChildren()
  panel.classList.add('lib-screen')
  const host = el('div', 'lib-scroll')
  panel.append(host)
  const slug = o.slug()
  if (!slug) {
    host.append(el('p', 'dim', 'Open a world first: fixtures are what a world wears.'))
    return
  }
  const doc = await o.current()
  let items: AssetItem[] = []
  try {
    items = await assetsvc.list()
  } catch {
    host.append(el('p', 'dim', 'The asset service is not answering, so only the built-ins are on offer.'))
  }
  host.append(el('p', 'dim', `${slug}: the built-in for each class, or a catalog asset of that class as the variant. Catalog assets need a finished mesh; describe and draw one under the class and it appears here.`))
  const draft: FixtureDoc = { version: 1, choices: { ...doc.choices } }
  for (const cls of FIXTURES) {
    const choice: FixtureChoice = { ...(draft.choices[cls.id] ?? {}) }
    draft.choices[cls.id] = choice
    const variants = items.filter((it) => it.kind === cls.id && it.state === 'finished')
    const g = group(cls.label, { note: cls.note })
    const body = bodyOf(g)
    body.append(select<string>({
      label: 'Variant',
      value: choice.asset ?? '',
      options: [{ value: '', label: `Built-in — ${cls.builtin}` }, ...variants.map((v) => ({ value: v.id, label: v.subject ?? v.id }))],
      note: variants.length ? `${variants.length} in the catalog` : 'no finished catalog asset of this class yet',
      onChange: (v) => { choice.asset = v || null },
    }))
    const settings = settingsOf(draft, cls.id)
    choice.settings = { ...settings }
    for (const s of cls.settings) {
      if (s.kind === 'number') {
        body.append(slider({ label: s.label, value: Number(settings[s.key]), min: s.min ?? 0, max: s.max ?? 10, step: s.step ?? 0.1, neutral: Number(s.default), note: s.note, onInput: (v) => { choice.settings![s.key] = v } }))
      } else if (s.kind === 'bool') {
        body.append(toggle({ label: s.label, value: Boolean(settings[s.key]), note: s.note, onChange: (v) => { choice.settings![s.key] = v } }))
      } else {
        const row = el('label', 'field')
        const input = document.createElement('input')
        input.type = 'color'
        input.value = String(settings[s.key])
        input.oninput = () => { choice.settings![s.key] = input.value }
        row.append(el('span', '', s.label), input)
        body.append(row)
      }
    }
    host.append(g)
  }
  const actions = el('div', 'lib-foot')
  actions.append(button({
    label: 'Save fixtures', icon: 'document-arrow-down', variant: 'primary',
    onClick: () => void o.save(draft).then(() => toast(`fixtures saved for ${slug}`, 'ok')).catch((e) => toast(`fixtures: ${(e as Error).message}`, 'danger', 6000)),
  }))
  panel.append(actions)
}
