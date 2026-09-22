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
