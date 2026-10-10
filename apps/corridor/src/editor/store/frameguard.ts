// The frame check, wired to a loaded site: the roads it measures against, the silent stamp, and
// the one banner it is still allowed to show. The measuring itself is framecheck.ts (pure).

import type { Site } from '../../world/scene'
import { el } from '../../ui/shell'
import { checkFrame, RoadIndex, stationsOf, type BakeFrame, type FrameVerdict, type Shapes } from './framecheck'
import { frameOf, type FrameStamp } from './schema'

/**
 * One road index per loaded site, built the first time a document needs measuring. Most documents
 * are stamped and never do; dc-metro-take-2's 63 km spine is ~6,300 stations and builds in a few
 * milliseconds, so this is about not doing it four times, not about doing it at all.
 */
const roadCache = new WeakMap<Site, RoadIndex>()
export function roadsOf(site: Site): RoadIndex | null {
  let idx = roadCache.get(site)
  if (!idx) {
    try {
      idx = new RoadIndex(stationsOf(site.chains()))
    } catch {
      return null
    }
    roadCache.set(site, idx)
  }
  return idx
}

/**
 * Check a freshly loaded document's frame against the bake, and stamp it when it measures right.
 *
 * THE STAMP IS IN MEMORY: `doc.frame` is set, the document is NOT marked dirty, and the stamp
 * reaches the file with the next save of it — every mode's `save` writes `frameOf(manifest)`
 * anyway. Marking it dirty would put "unsaved edits" in front of somebody who has edited nothing.
 */
export function guardFrame(doc: { frame?: FrameStamp }, site: Site, shapes: Shapes, noun: string): FrameVerdict {
  const frame = (site.manifest as unknown as { frame?: BakeFrame }).frame
  const v = checkFrame(doc.frame, frame, shapes, () => roadsOf(site), noun)
  if (v.state === 'fits') doc.frame = frameOf(site.manifest)
  return v
}

/**
 * The banner, or null — and null is the usual answer now.
 *
 * Only two verdicts earn it: `old`, which the roads demonstrated and which comes with a button that
 * does the move, and `other`, a stamp naming a different anchor, which the editor cannot repair.
 * An unstamped file the roads cannot judge says nothing: that is not evidence of anything.
 */
export function frameNotice(file: string, v: FrameVerdict | null, move: (() => void) | null): HTMLElement | null {
  if (!v || (v.state !== 'old' && v.state !== 'other')) return null
  const b = el('div', 'framewarn')
  b.append(el('strong', '', v.state === 'old' ? `${file} sits off the road in this frame` : `${file} was written in a different frame`))
  b.append(el('span', '', v.message))
  if (v.state === 'old' && move) {
    const btn = el('button', 'primary', 'Move them into this frame') as HTMLButtonElement
    btn.title = 'turns every coordinate in the file by the bake’s recorded UTM→ENU fit; save to keep it'
    btn.onclick = move
    b.append(btn)
  }
  return b
}
