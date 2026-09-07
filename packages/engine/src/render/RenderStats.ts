// What the perf overlay reads from a renderer.

export interface RenderStats {
  drawCalls: number
  triangles: number
  /** Resident world chunks (or whatever the game's streaming unit is). */
  chunks: number
}
