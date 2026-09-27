// Moving worlds between machines: the definitions, and the baked result.
//
// Rich, 2026-09-27: "have the ability to import and export world configs for each area and game"
// — and, in the same breath, "I want to reset the image so it ships with zero built in configs
// and we can start by importing crofton or crownsville or arrowhead".
//
// Those two asks are one feature. An editor that ships empty is only usable if there is an
// obvious way to put something in it, and the obvious place is the world picker: on a fresh
// install it reads "no world · 0 defined", and it is the first thing anyone clicks. So the
// import lives at the bottom of that menu rather than inside a mode you would have to know to
// visit.
//
// TWO SIZES OF THING, deliberately separate:
//
//   a DEFINITION   a few hundred bytes of JSON — where, how big, which road is the spine, plus
//                  the levels set there. This is how you hand somebody a PLACE TO BAKE.
//   a BAKED WORLD  hundreds of megabytes of raster. This is how you hand them the RESULT without
//                  the eight hours.
//
// The backend has had both routes for a while (tools/worldeditor/server.mjs) and nothing in the
// page had ever called them, which is a feature that exists only for whoever reads the source.

import { api, type World } from './api'
import { bodyOf, empty, group, readout, toggle } from '../ui/controls'
import { button, confirm, el, toast } from '../ui/shell'

/** Ask for a file without keeping an `<input>` in the DOM for the rest of the session. */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = el('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    // `cancel` fires on modern browsers; without it a dismissed dialog leaves a pending promise
    // and the button looks stuck forever.
    input.oncancel = () => { input.remove(); resolve(null) }
    input.onchange = () => { const f = input.files?.[0] ?? null; input.remove(); resolve(f) }
    document.body.append(input)
    input.click()
  })
}

/** Start a download of a URL the service will answer with a content-disposition. */
function download(url: string): void {
  const a = el('a')
  a.href = url
  a.download = ''
  a.style.display = 'none'
  document.body.append(a)
  a.click()
  a.remove()
}

/** What the import returned, in a sentence rather than a JSON blob. */
function importSummary(r: { imported: string[]; levels: string[]; skipped: { slug?: string; level?: string; why: string }[] }): string {
  const bits: string[] = []
  if (r.imported.length) bits.push(`${r.imported.length} world${r.imported.length === 1 ? '' : 's'}`)
  if (r.levels.length) bits.push(`${r.levels.length} level${r.levels.length === 1 ? '' : 's'}`)
  if (!bits.length) return r.skipped.length ? `nothing imported — ${r.skipped[0].why}` : 'nothing in that file'
  return `imported ${bits.join(' and ')}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}`
}

export interface TransferOpts {
  /** the world the picker is pointing at, if any */
  selected: () => string | null
  worlds: () => World[]
  /** re-read the world list and redraw, after something arrived */
  reload: () => Promise<void>
}

/**
 * The rows that go at the bottom of the world menu.
 *
 * Import first and always enabled, because on an empty editor it is the only one that can do
 * anything — and an empty menu with nothing in it at all is the state this whole feature exists
 * to fix.
 */
export function worldMenuTransfer(o: TransferOpts, close: () => void): HTMLElement[] {
  const rows: HTMLElement[] = []
  const row = (label: string, note: string, onClick: () => void) => {
    const b = el('button', 'world-row transfer')
    b.append(el('span', 'world-slug', label), el('span', 'world-meta', note))
    b.onclick = () => { close(); onClick() }
    rows.push(b)
    return b
  }

  row('Import a world…', 'a .corridor.json bundle', async () => {
    const file = await pickFile('.json,application/json')
    if (!file) return
    let bundle: unknown
    try {
      bundle = JSON.parse(await file.text())
    } catch (e) {
      // A person will hand this a zip sooner or later, because both things are called "a world".
      toast(file.name.endsWith('.zip')
        ? 'that is a baked world — upload it under Bake, not here'
        : `${file.name} is not JSON: ${(e as Error).message}`, 'warn', 6000)
      return
    }
    try {
      let r = await api.importWorlds(bundle)
      // "already here" is the common case when you are moving a world between two editors, and
      // making someone find a checkbox to say "yes, that one" is a worse question than asking.
      const clashes = r.skipped.filter((s) => s.why.includes('already here'))
      if (clashes.length && await confirm({
        title: 'Already here',
        message: `${clashes.length} of these already exist on this volume. Overwrite them?`,
        ok: 'Overwrite',
        danger: true,
      })) {
        r = await api.importWorlds(bundle, true)
      }
      toast(importSummary(r), r.imported.length || r.levels.length ? 'ok' : 'warn', 6000)
      await o.reload()
    } catch (e) {
      toast(`import failed: ${(e as Error).message}`, 'danger', 8000)
    }
  })

  const slug = o.selected()
  if (slug) {
    row(`Export ${slug}`, 'definition and its levels', () => download(api.exportWorldsUrl([slug])))
  }
  const n = o.worlds().length
  if (n > 1) row('Export everything', `${n} worlds`, () => download(api.exportWorldsUrl()))
  return rows
}

/**
 * The baked half, for the Bake panel: the result as one zip, in and out.
 *
 * Separate from the definition above because the numbers are four orders of magnitude apart and
 * so are the failure modes. A definition either parses or it does not; an archive can be refused
 * by a proxy that never showed it to the service, can be too big for the service to hold in
 * memory, and takes long enough that silence reads as a hang.
 */
export function bakedTransferGroup(o: TransferOpts): HTMLElement {
  const g = group('Move a baked world', {
    note: 'The bake itself, as one file — for getting a world onto another machine without the hours.',
  })
  const body = bodyOf(g)
  const slug = o.selected()
  const world = o.worlds().find((w) => w.slug === slug)

  let webOnly = true
  body.append(toggle({
    label: 'viewer half only',
    value: webOnly,
    note: 'web/ alone: what the browser needs. The full archive also carries the source rasters a re-bake would want, and is several times larger.',
    onChange: (v) => { webOnly = v },
  }))

  const bar = el('div', 'row-actions')
  if (world?.baked) {
    bar.append(button({
      label: `Download ${slug}`,
      icon: 'arrow-down-tray',
      onClick: () => download(api.archiveUrl(slug!, webOnly)),
    }))
  } else {
    body.append(empty(slug ? `${slug} is not baked yet — nothing to download.` : 'No world selected.'))
  }

  const progress = readout('upload', 'idle')
  bar.append(button({
    label: 'Upload a baked world…',
    icon: 'arrow-up-tray',
    onClick: async () => {
      const file = await pickFile('.zip,application/zip')
      if (!file) return
      const mb = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`
      try {
        // The archive names its own site from its top-level directory, so there is no slug to ask
        // for — and asking would let the two disagree.
        let r = await api.importSite(file, false, (sent, total) => {
          progress.querySelector('.field-value')!.textContent = `${mb(sent)} of ${mb(total)}`
        })
        toast(`${r.site}: ${r.files} files, ${mb(r.bytes)}`, 'ok', 6000)
        void r
        await o.reload()
      } catch (e) {
        const message = (e as Error).message
        if (message.includes('already baked') && await confirm({
          title: 'Already baked',
          message: `${message} Overwrite it?`,
          ok: 'Overwrite',
          danger: true,
        })) {
          try {
            const r = await api.importSite(file, true, (sent, total) => {
              progress.querySelector('.field-value')!.textContent = `${mb(sent)} of ${mb(total)}`
            })
            toast(`${r.site}: ${r.files} files, ${mb(r.bytes)}`, 'ok', 6000)
            await o.reload()
          } catch (e2) {
            toast(`upload failed: ${(e2 as Error).message}`, 'danger', 9000)
          }
        } else {
          toast(`upload failed: ${message}`, 'danger', 9000)
        }
      } finally {
        progress.querySelector('.field-value')!.textContent = 'idle'
      }
    },
  }))
  body.append(bar, progress)
  return g
}
