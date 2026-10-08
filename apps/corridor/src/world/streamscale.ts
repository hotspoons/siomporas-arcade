// One number every budgeted builder reads: how much of its per-frame budget the frame can afford.
//
// The grass generator, the tree planter, the grading pump and the building fill each take a fixed
// millisecond budget a frame (GRASS_MS_PER_FRAME, TREE_PLANT_BUDGET_MS, STREAM_BUDGET_MS). Fixed is
// the problem: on the DC Beltway under the test rig the frame's own work was 16.6 ms at the median
// (2026-10-08), so every one of those budgets was spent ON TOP of a full frame, and the grass alone
// was 4.5 ms of it, every frame, by design — the generator runs to its deadline while the car moves.
// The streaming never needed those milliseconds THIS frame; it needed them eventually, and the
// rims already size themselves to what the generator drains.
//
// So the frame loop measures itself and sets this scale (`main.ts` frame governor): near 1 while
// there is headroom, down toward `STREAM_SCALE_MIN` while the frame is over budget. A builder
// multiplies its budget by it. A 0 would starve the world of ground; the floor keeps it moving.
export let streamScale = 1

export function setStreamScale(v: number): void {
  streamScale = v > 1 ? 1 : v < 0.05 ? 0.05 : v
}

/** a per-frame millisecond budget, scaled to what the frame can afford right now */
export function scaledMs(base: number): number {
  return base * streamScale
}
