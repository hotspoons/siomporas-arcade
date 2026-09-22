// Panel bits for the editor's four mode panels.
//
// These are now thin adapters over the shared control set in `src/ui/controls.ts`, kept at this
// path and with these signatures so areas.ts / place.ts / grow.ts / structures.ts did not have to
// change to pick up the new look. One definition of what a slider is, for both apps.
export { el } from '../ui/shell'
import { slider as uiSlider } from '../ui/controls'

/**
 * A labelled range with its value, and a dot that tells you at a glance whether this knob is
 * still neutral — the whole point of an adjustment area is that almost every knob in it is.
 * Double-click the label to snap back to neutral.
 */
export function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  neutral: number,
  note: string,
  onInput: (v: number) => void,
): HTMLElement {
  return uiSlider({ label, value, min, max, step, neutral, note, onInput })
}

/**
 * The loudest thing the panel can say. A frame mismatch means every coordinate in the file is
 * displaced — on 2026-09-22 by a median of 40 m and up to 439 m — while every polygon still draws
 * a plausible shape over plausible ground. Nothing else in this editor is wrong in a way you
 * cannot see, so nothing else gets a banner.
 */
export function frameBanner(file: string, why: string): HTMLElement {
  const b = el('div', 'framewarn')
  b.append(el('strong', '', `${file} was authored in a different frame`))
  b.append(el('span', '', why))
  b.append(el('span', 'dim', 'Regenerate the seeded areas (`python -m corridor areas <slug> --overwrite`) and re-run grow; anything drawn by hand has to be redrawn.'))
  return b
}
