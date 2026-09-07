// F3 overlay: frame-time graph, sim ticks/frame, draw calls, triangles,
// resident chunk count, JS heap. Canvas-drawn so it costs one draw.

import type { LoopStats } from './GameLoop'
import type { RenderStats } from '../render/RenderStats'

export class PerfOverlay {
  readonly el: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private visible = false
  private acc = 0

  constructor(parent: HTMLElement) {
    this.el = document.createElement('canvas')
    this.el.className = 'perf hidden'
    this.el.width = 300
    this.el.height = 128
    parent.appendChild(this.el)
    this.ctx = this.el.getContext('2d')!
  }

  toggle(force?: boolean): boolean {
    this.visible = force ?? !this.visible
    this.el.classList.toggle('hidden', !this.visible)
    return this.visible
  }

  update(loop: LoopStats, render: RenderStats, dt: number, extra: string): void {
    if (!this.visible) return
    this.acc += dt
    if (this.acc < 1 / 20) return
    this.acc = 0
    const c = this.ctx
    const w = this.el.width
    const h = this.el.height
    c.clearRect(0, 0, w, h)
    c.fillStyle = 'rgba(0,0,0,0.6)'
    c.fillRect(0, 0, w, h)
    // Graph: 120 frames, 33 ms full scale.
    const gx = 8
    const gy = 60
    const gw = w - 16
    const gh = 60
    c.strokeStyle = 'rgba(255,255,255,0.15)'
    c.beginPath()
    for (const ms of [16.7, 8.3]) {
      const y = gy + gh - (ms / 33) * gh
      c.moveTo(gx, y)
      c.lineTo(gx + gw, y)
    }
    c.stroke()
    c.strokeStyle = '#25e8ff'
    c.beginPath()
    const n = loop.history.length
    for (let i = 0; i < n; i++) {
      const v = loop.history[(loop.historyHead + i) % n]
      const x = gx + (i / (n - 1)) * gw
      const y = gy + gh - Math.min(1, v / 33) * gh
      if (i === 0) c.moveTo(x, y)
      else c.lineTo(x, y)
    }
    c.stroke()
    c.fillStyle = '#e8f6ff'
    c.font = '12px ui-monospace, monospace'
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    const heap = mem ? `${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB` : 'n/a'
    c.fillText(`${loop.fps.toFixed(0)} fps  present ${loop.presentFps.toFixed(0)}  frame ${loop.frameMs.toFixed(2)} ms`, 8, 14)
    c.fillText(`sim ${loop.simTicks} ticks/frame  ${loop.simMs.toFixed(2)} ms   render ${loop.renderMs.toFixed(2)} ms`, 8, 30)
    c.fillText(`draws ${render.drawCalls}  tris ${(render.triangles / 1000).toFixed(1)}k  chunks ${render.chunks}  heap ${heap}`, 8, 46)
    c.fillText(extra, 8, h - 6)
  }
}
