// Pinhole projection onto the logical screen (y up, origin bottom-left).

import { FOV_DEG } from './RenderTuning'

export class Projection {
  width = 320
  height = 224
  readonly camDepth = 1 / Math.tan(((FOV_DEG / 2) * Math.PI) / 180)

  /** Camera-relative (cx, cy, cz) → screen x, y and the per-metre scale. */
  scaleAt(cz: number): number {
    return (this.camDepth / Math.max(0.05, cz)) * (this.height / 2)
  }

  screenX(cx: number, scale: number): number {
    return this.width / 2 + cx * scale
  }

  screenY(cy: number, scale: number): number {
    return this.height / 2 + cy * scale
  }
}
