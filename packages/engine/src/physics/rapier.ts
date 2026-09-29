// The one place that loads Rapier, and the only file in the repo allowed to name the package.
//
// WHY A LOADER AND NOT AN IMPORT. `@dimforge/rapier3d-compat` inlines its WebAssembly as base64
// inside the JavaScript: `dist/rapier.mjs` is 4.3 MB on disk (measured, 0.21.0). A static import
// puts all of that in whatever chunk touches physics, which for a Vite build means the entry chunk
// of any game that so much as types `PhysicsWorld`. A dynamic import inside a function gives the
// bundler a split point instead, so a menu, a level list or a game that never turns physics on
// pays nothing, and the download happens while a world is loading rather than before it appears.
//
// WHY THE `-compat` BUILD AND NOT `@dimforge/rapier3d`. The plain package ships the `.wasm` as a
// separate asset and relies on the host resolving it — which Vite does, and Node does not, and the
// headless probes and vitest suites in this repo are Node. One package that behaves identically in
// a browser, in a probe and in a unit test is worth the bigger chunk, because "the physics test
// passes in CI and the game falls through the floor" is the failure it buys off.
//
// WHY A SINGLETON. Rapier's wasm module has module-level state and `init()` is not idempotent in
// any useful sense; every `World` in the process shares it. So this caches the promise, and
// concurrent callers (a game booting while a probe warms up) get the same one rather than racing.
//
// ONE MORE RULE, AND IT IS LOAD-BEARING: nothing outside `packages/engine/src/physics/` imports
// `@dimforge/rapier3d-compat`. Rapier lives in this package's own `node_modules` (the repo root
// has an older copy that `@types/three` drags in, types-only), and two copies of the wasm in one
// bundle is two heaps, two allocators, and handles from one that are garbage in the other.

export type Rapier = typeof import('@dimforge/rapier3d-compat')

let loaded: Rapier | null = null
let loading: Promise<Rapier> | null = null

/**
 * Load and initialise Rapier. Safe to call many times; the wasm is compiled once.
 *
 * Await this before constructing anything in this directory — every class here assumes the module
 * is up, and says so by throwing rather than by crashing inside wasm.
 */
export function loadRapier(): Promise<Rapier> {
  if (loaded) return Promise.resolve(loaded)
  if (loading) return loading
  loading = import('@dimforge/rapier3d-compat').then(async (mod) => {
    await mod.init()
    loaded = mod
    return mod
  })
  return loading
}

/**
 * The loaded module, synchronously.
 *
 * Everything in the hot path wants Rapier without an await, and by then it is certainly loaded —
 * but "certainly" is how a null lands in a shader. The throw names the fix.
 */
export function rapier(): Rapier {
  if (!loaded) throw new Error('rapier: await loadRapier() before using the physics module')
  return loaded
}

/** Has the module finished loading? For a caller deciding whether to show a spinner. */
export function rapierReady(): boolean {
  return loaded !== null
}
