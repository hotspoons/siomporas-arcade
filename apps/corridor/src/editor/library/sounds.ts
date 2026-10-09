// The Sounds tab in the library: the bank itself, slot by slot, every clip with a Listen, and where
// it all came from. The place to find out what `crash.heavy` sounds like before putting it on a
// car, and the place that says these are CC0 and whose they were.

import { SLOT_HELP, SOUND_SLOTS, type SoundSlot } from '../../game/audio/soundbank'
import { button, el, type Tab } from '../../ui/shell'
import { listen, previewSfx } from './soundpicker'
import { soundBoard } from './soundboard'
import { bodyOf, group } from '../../ui/controls'

export function soundsExtension(): { tabs: Tab[] } {
  return { tabs: [{ id: 'sounds', label: 'Sounds', icon: 'speaker-wave', build: buildSoundsTab }] }
}

function buildSoundsTab(host: HTMLElement): void {
  host.replaceChildren()
  const p = previewSfx()
  const render = () => {
    host.replaceChildren()
    const head = el('div', 'panel-note')
    head.append(el('div', '', 'The sound bank: what the game plays for each thing it says. A vehicle, an actor or a weapon may give any slot clips of its own on its Sounds tab; a program reaches the same slots as api.audio.'))
    const credit = el('div', 'field-note')
    credit.append('Cut by tools/sounds/build.py from CC0 recordings — Kenney, BigSoundBank, OpenGameArt, the Internet Archive — except the tyres, which are Rich’s own and not free; the provenance is ')
    const a = el('a', '', 'public/sounds/CREDITS.md')
    a.href = '/sounds/CREDITS.md'
    a.target = '_blank'
    credit.append(a, '.')
    head.append(credit)
    host.append(head)
    // THE BOARD FIRST: listen to anything, trim it, shape it, save it as a clip of your own
    const board = group('Sound board', { collapsed: false, note: 'any clip on a waveform — drag a selection, shape it, Play / Loop, Save to an asset as a new clip, or download it' })
    soundBoard(bodyOf(board))
    host.append(board)
    const bank = p.bank
    if (!bank) {
      host.append(el('div', 'field-note', 'loading the bank…'))
      setTimeout(render, 400)
      return
    }
    for (const slot of SOUND_SLOTS) {
      const s = bank.manifest.slots[slot]
      const sec = el('section', 'snd-bank-slot')
      const h = el('div', 'snd-head')
      const name = el('div', 'snd-name')
      name.append(el('code', '', slot))
      name.append(el('div', 'field-note', SLOT_HELP[slot as SoundSlot]))
      h.append(name)
      h.append(el('span', 'snd-state', s ? `${s.clips.length} clip${s.clips.length === 1 ? '' : 's'}${s.loop ? ' · loop' : ''}` : 'missing from the bank'))
      const acts = el('div', 'panel-actions snd-acts')
      acts.append(button({ label: 'Listen', icon: 'play', variant: 'ghost', onClick: () => listen(slot) }))
      h.append(acts)
      sec.append(h)
      const list = el('div', 'snd-bank-clips')
      for (const c of s?.clips ?? []) {
        const entry = c.file.replace(/\.ogg$/, '')
        const b = button({ label: `${entry.split('/').pop()} · ${c.s.toFixed(2)} s`, icon: 'play', variant: 'ghost', onClick: () => listen(slot, [], entry) })
        b.title = entry
        list.append(b)
      }
      sec.append(list)
      host.append(sec)
    }
  }
  render()
}
