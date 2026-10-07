/**
 * How a branch road is cut into pump units.
 *
 * A branch is built lazily one chunk at a time as the eye reaches it, so a 60 km motorway ring (the
 * two Capital Beltway carriageways are 63.0 and 61.9 km) never lands in the pump as a single unit
 * that blocks everything else until it is done. The pieces are cut on the SAME 6 m station grid a
 * whole-branch build would use, and neighbouring chunks SHARE their boundary station, so the meshes
 * abut exactly — no gap between them and no overlap to z-fight — and the absolute `s` the road
 * builder reads keeps the lane-dash phase continuous across a seam.
 *
 * Pure and exported so the housekeeping can be checked without a browser.
 */

/** the station spacing every road in the world is sampled on */
export const CHUNK_STEP = 6

/** how many chunks a branch of `len` metres is cut into */
export const nChunksOf = (len: number, chunkM: number): number => Math.max(1, Math.ceil(len / chunkM))

/** stations on the global grid, inclusive of both ends; two is the fewest that makes a quad */
export const nStationsOf = (len: number): number => Math.max(2, Math.floor(len / CHUNK_STEP) + 1)

/** the [first, last] station index of chunk `k`. The last is the next chunk's first. */
export const chunkStations = (len: number, k: number, chunkM: number): [number, number] => {
  const n = nChunksOf(len, chunkM)
  const last = nStationsOf(len) - 1
  return [Math.floor((k * last) / n), Math.floor(((k + 1) * last) / n)]
}

/** every chunk's station range, in order */
export const chunkSegments = (len: number, chunkM: number): [number, number][] =>
  Array.from({ length: nChunksOf(len, chunkM) }, (_, k) => chunkStations(len, k, chunkM))
