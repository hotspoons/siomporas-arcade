// The Sounds group on a vehicle or an actor, and the one-clip field on a weapon: what each slot
// plays for THIS thing, heard before it is saved.
//
// Rich, 2026-10-09: "make sure this sound bank is featured in the level editor with the ability to
// provide custom sounds for any vehicle, actor, etc." So every slot the game plays is a row here,
// saying what it is for and what it currently resolves to — the bank's clips, this document's own,
// or silence — with a Listen button on each, because audio you cannot hear while choosing is audio
// nobody chooses. A slot's own clips are a list: bank clips picked from a menu, another slot
// (`slot:gun.fire.shotgun` — "this car's gun sounds like a shotgun"), a URL, or a file uploaded to
// the build's asset, which the asset service stores and the document names as `asset:<id>/<file>`.
//
// The preview player is its own `Sfx` with the same bank the game loads, unlocked by the click
// that asks to listen (the gesture the browser needs). It never touches the game's bus.

import { assetsvc } from '../../assets/assetsvc'
import { Sfx } from '../../game/audio/sfx'
import { SLOT_HELP, SOUND_SLOTS, type SoundOverrides, type SoundSlot } from '../../game/audio/soundbank'
import { bodyOf, group, readout, select, textField } from '../../ui/controls'
import { button, el, toast } from '../../ui/shell'

/** the preview player: one for the whole editor, made on the first Listen */
let preview: Sfx | null = null
export function previewSfx(): Sfx {
  if (!preview) {
    preview = new Sfx()
    void preview.loadBank('/sounds/bank.json', (id, file) => assetsvc.fileUrl(id, `sounds/${file}`))
    preview.setUserAudio(1, false)
  }
  preview.unlock()
  return preview
}

/** Play one of a slot's clips under these overrides, now — the Listen button. */
export function listen(slot: string, scopes: (SoundOverrides | null | undefined)[] = [], entry?: string): void {
  const p = previewSfx()
  if (!p.bank) { toast('the sound bank is still loading', 'info', 1500); return }
  // one named entry, not the slot: a scope that pins it
  const sc = entry !== undefined ? [{ [slot]: [entry] } as SoundOverrides] : scopes
  if (!p.play(slot, { scopes: sc, vary: 0 })) toast(`${slot}: nothing to play — the slot is silent`, 'info', 1800)
}

export interface SoundsGroupOpts {
  /** the document's overrides, read fresh on every render */
  get: () => SoundOverrides | undefined
  /** write them back (undefined clears the field). The caller stages and re-renders */
  set: (o: SoundOverrides | undefined) => void
  /** the catalog asset uploads are stored under; null disables uploading and says why */
  assetId: string | null
  /** which slots to show. Default: all of them */
  slots?: readonly SoundSlot[]
  title?: string
  note?: string
}

/**
 * The group. One row a slot: its name, what it is for, what it resolves to and a Listen; an
 * `edit` button opens that slot's own list under it. Rebuilt by the caller on every change, so
 * the open slot is remembered here across rebuilds.
 */
const openSlots = new Set<string>()

export function soundsGroup(o: SoundsGroupOpts): HTMLElement {
  const over = o.get() ?? {}
  const own = Object.keys(over).length
  const g = group(o.title ?? `Sounds${own ? ` — ${own} of its own` : ''}`, {
    collapsed: false,
    note: o.note ?? 'what this plays for each thing the game says. Absent slots use the bank (public/sounds, CC0); a slot of its own is a list of clips picked from at random',
  })
  const body = bodyOf(g)
  const p = previewSfx()
  const bankClips = (slot: string) => p.bank?.bankEntries(slot) ?? []

  for (const slot of o.slots ?? SOUND_SLOTS) {
    const mine = over[slot]
    const row = el('div', 'snd-row')
    const head = el('div', 'snd-head')
    const name = el('div', 'snd-name')
    name.append(el('code', '', slot))
    name.append(el('div', 'field-note', SLOT_HELP[slot]))
    head.append(name)
    const what = mine === undefined ? `bank · ${bankClips(slot).length || '?'} clip${bankClips(slot).length === 1 ? '' : 's'}`
      : mine.length === 0 ? 'silent' : `own · ${mine.length} clip${mine.length === 1 ? '' : 's'}`
    const state = el('span', `snd-state${mine === undefined ? '' : mine.length ? ' own' : ' silent'}`, what)
    head.append(state)
    const acts = el('div', 'panel-actions snd-acts')
    acts.append(button({ label: 'Listen', icon: 'play', variant: 'ghost', onClick: () => listen(slot, [over]) }))
    const isOpen = openSlots.has(slot)
    acts.append(button({ label: isOpen ? 'Done' : 'Edit', variant: 'ghost', onClick: () => { if (isOpen) openSlots.delete(slot); else openSlots.add(slot); o.set(o.get()) } }))
    head.append(acts)
    row.append(head)

    if (isOpen) row.append(slotEditor(slot, o, over, bankClips))
    body.append(row)
  }
  return g
}

function slotEditor(slot: SoundSlot, o: SoundsGroupOpts, over: SoundOverrides, bankClips: (slot: string) => string[]): HTMLElement {
  const box = el('div', 'snd-edit')
  const mine = over[slot]
  const write = (entries: string[] | undefined) => {
    const next: SoundOverrides = { ...o.get() }
    if (entries === undefined) delete next[slot]; else next[slot] = entries
    o.set(Object.keys(next).length ? next : undefined)
  }
  const add = (e: string) => write([...(mine ?? []), e])

  if (mine === undefined) {
    box.append(el('div', 'field-note', 'using the bank. Add a clip to give this slot its own list, or make it silent.'))
  } else if (!mine.length) {
    box.append(el('div', 'field-note', 'silent — nothing plays for this.'))
  } else {
    for (const [i, e] of mine.entries()) {
      const line = el('div', 'panel-actions snd-entry')
      line.append(el('code', 'snd-entry-name', describeEntry(e)))
      line.append(button({ label: '', icon: 'play', variant: 'ghost', title: 'listen to this one', onClick: () => listen(slot, [], e) }))
      line.append(button({ label: '', icon: 'x-mark', variant: 'ghost', title: 'remove', onClick: () => write(mine.filter((_, k) => k !== i)) }))
      box.append(line)
    }
  }

  // add from the bank — every clip the bank has, this slot's first
  const all = [...bankClips(slot), ...SOUND_SLOTS.filter((s) => s !== slot).flatMap(bankClips)]
  if (all.length) {
    box.append(select({
      label: 'Add a bank clip', value: '',
      options: [{ value: '', label: '— choose —' }, ...all.map((c) => ({ value: c, label: c }))],
      onChange: (v) => { if (v) add(v) },
    }))
  }
  box.append(select({
    label: 'Or another slot’s clips', value: '',
    options: [{ value: '', label: '— choose —' }, ...SOUND_SLOTS.filter((s) => s !== slot).map((s) => ({ value: `slot:${s}`, label: s }))],
    note: 'e.g. a car whose gun is a shotgun: gun.fire → slot:gun.fire.shotgun',
    onChange: (v) => { if (v) add(v) },
  }))
  box.append(textField({
    label: 'Or a URL', value: '', placeholder: 'https://… or /sounds/crash-heavy/slam-3',
    onChange: (v) => { const t = v.trim(); if (t) add(t) },
  }))

  // upload: a file under the build's asset
  const up = el('div', 'panel-actions')
  if (o.assetId) {
    const input = el('input', 'input') as HTMLInputElement
    input.type = 'file'
    input.accept = 'audio/*,.ogg,.mp3,.wav,.m4a,.webm,.flac'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      try {
        const r = await assetsvc.uploadSound(o.assetId!, f)
        toast(`${f.name}: ${(r.bytes / 1024).toFixed(0)} KB stored on ${o.assetId}`, 'ok', 2500)
        add(r.entry)
      } catch (e) {
        toast(`upload failed: ${(e as Error).message}`, 'warn', 5000)
      }
    }
    const lab = el('label', 'field text')
    lab.append(el('span', 'field-label', 'Upload a clip of your own'))
    lab.append(input)
    up.append(lab)
  } else {
    up.append(el('div', 'field-note', 'uploading needs a model chosen first — the clip is stored under the build’s asset'))
  }
  box.append(up)

  const foot = el('div', 'panel-actions')
  if (mine === undefined || mine.length) foot.append(button({ label: 'Make it silent', variant: 'ghost', onClick: () => write([]) }))
  if (mine !== undefined) foot.append(button({ label: 'Back to the bank', variant: 'ghost', onClick: () => write(undefined) }))
  box.append(foot)
  return box
}

/** an entry, as a person reads it */
export function describeEntry(e: string): string {
  if (e.startsWith('slot:')) return `↪ ${e.slice(5)}`
  if (e.startsWith('asset:')) return `⬆ ${e.slice(6)}`
  return e
}

/**
 * One clip, for a weapon's `audio.fire` / `audio.reload`: a bank clip from the menu, a URL or an
 * upload, with a Listen. Empty is "the game's own".
 */
export function clipField(o: { label: string; value: string | undefined; assetId: string | null; slot: SoundSlot; onChange: (v: string | undefined) => void }): HTMLElement {
  const wrap = el('div', 'snd-clipfield')
  const p = previewSfx()
  const bank = p.bank ? [...p.bank.bankEntries(o.slot), ...SOUND_SLOTS.filter((s) => s !== o.slot).flatMap((s) => p.bank!.bankEntries(s))] : []
  const options = [{ value: '', label: `— the game’s ${o.slot} —` }, ...bank.map((c) => ({ value: c, label: c }))]
  const cur = o.value ?? ''
  if (cur && !bank.includes(cur)) options.splice(1, 0, { value: cur, label: describeEntry(cur) })
  wrap.append(select({ label: o.label, value: cur, options, onChange: (v) => o.onChange(v || undefined) }))
  const acts = el('div', 'panel-actions')
  acts.append(button({ label: 'Listen', icon: 'play', variant: 'ghost', onClick: () => (cur ? listen(o.slot, [], cur) : listen(o.slot)) }))
  if (o.assetId) {
    const input = el('input', 'input') as HTMLInputElement
    input.type = 'file'
    input.accept = 'audio/*,.ogg,.mp3,.wav,.m4a,.webm,.flac'
    input.onchange = async () => {
      const f = input.files?.[0]
      if (!f) return
      try {
        const r = await assetsvc.uploadSound(o.assetId!, f)
        o.onChange(r.entry)
      } catch (e) {
        toast(`upload failed: ${(e as Error).message}`, 'warn', 5000)
      }
    }
    acts.append(input)
  }
  wrap.append(acts)
  wrap.append(readout('or', 'a URL, typed below', false))
  wrap.append(textField({ label: '', value: cur && !bank.includes(cur) ? cur : '', placeholder: 'https://… or asset:<id>/<file>', onChange: (v) => { const t = v.trim(); if (t) o.onChange(t) } }))
  return wrap
}
