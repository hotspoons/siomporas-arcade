// A presentation style owns the post stack and the per-frame present. The
// scene, camera and geometry are shared; styles only change how they are shown.

import type { Camera, Scene, WebGLRenderer } from 'three'

export interface StyleFrameInfo {
  /** 0..1+ speed feel from the sim (drives blur/aberration). */
  speedT: number
  boost: number
  shockAge: number
  dt: number
  time: number
  shield: number
  hit: number
}

export interface Style {
  readonly name: 'modern' | 'retro'
  attach(renderer: WebGLRenderer, scene: Scene, camera: Camera): void
  detach(): void
  resize(width: number, height: number, pixelRatio: number): void
  render(info: StyleFrameInfo): void
  /** Called when the XR session state changes: styles must degrade safely. */
  setXr(active: boolean): void
}
