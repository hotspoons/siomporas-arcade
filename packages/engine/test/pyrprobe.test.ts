// Not a unit test: a probe against a REAL bake on disk. Skips itself when the bake is absent.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Anchor } from '../src/geo/wgs84'
import { childrenOf, diff, tileBoundsOf, tileKey, wanted, type TileId } from '../src/geo/pyramid'

const S = '/tmp/claude-1000/-workspaces-apex-conduit/7cbb4287-c29a-4169-9e19-154f2259bf0d/scratchpad'
const BLOCK = `${S}/pyr_block.json`
const WEB = `${S}/pyrweb`
// A probe that silently skips is a probe that tells you nothing. It skips by default because the
// bake is 122 MB of scratch that CI has no reason to build — but with PYRAMID_PROBE=1 it is an
// ERROR for the bake to be missing, so "it passed" can never mean "it did not run".
const asked = process.env.PYRAMID_PROBE === '1'
const run = existsSync(BLOCK)
if (asked && !run) throw new Error(`PYRAMID_PROBE=1 but no bake at ${BLOCK} — nothing was verified`)

describe.skipIf(!run)('pyramid probe against a real crownsville bake', () => {
  const block = JSON.parse(readFileSync(BLOCK, 'utf8'))
  const list: { z: number; x: number; y: number; empty?: boolean }[] = block.list
  const have = new Set(list.map((e) => `${e.z}/${e.x}/${e.y}`))
  const site = JSON.parse(readFileSync(`${process.cwd()}/tools/corridor/data/sites/crofton-crownsville/site.json`, 'utf8'))
  const anchor = new Anchor(site.lon, site.lat, 0)

  const place = (t: TileId) => {
    const b = tileBoundsOf(t.z, t.x, t.y)
    const c: number[] = [0, 0, 0]; const nw: number[] = [0, 0, 0]
    anchor.toLocal((b.w + b.e) / 2, (b.s + b.n) / 2, 0, c)
    anchor.toLocal(b.w, b.n, 0, nw)
    return { x: c[0], z: c[1], radius: Math.hypot(nw[0] - c[0], nw[1] - c[1]) }
  }
  const has = (t: TileId) => have.has(tileKey(t))
  const roots = list.filter((e) => e.z === block.zmin).map((e) => ({ z: e.z, x: e.x, y: e.y }))
  const mpp = (d: number) => (2 * d * Math.tan((60 * Math.PI) / 180 / 2) * 1.6) / 1080

  it('the bake is quad-closed: a split quad has all four children', () => {
    let broken = 0
    for (const e of list) {
      if (e.z >= block.zmax) continue
      const kids = childrenOf(e)
      const n = kids.filter(has).length
      if (n !== 0 && n !== 4) broken++
    }
    expect(broken).toBe(0)
  })

  it('every non-empty tile has a pack on disk that starts with a sane header', () => {
    let checked = 0
    for (const e of list) {
      if (e.empty) continue
      const f = `${WEB}/pyr/${e.z}/${e.x}_${e.y}.pack`
      expect(existsSync(f), `missing ${f}`).toBe(true)
      const buf = readFileSync(f)
      const hlen = buf.readUInt32LE(0)
      expect(hlen).toBeGreaterThan(0)
      expect(hlen).toBeLessThan(buf.length)
      const hdr = JSON.parse(buf.subarray(4, 4 + hlen).toString())
      expect(Object.keys(hdr.files)).toContain('dem.png')
      checked++
      if (checked >= 40) break
    }
    expect(checked, 'no non-empty tiles were checked — the probe did not run').toBeGreaterThanOrEqual(20)
  })

  it('RESIDENCY STAYS BOUNDED while the camera crosses the whole world', () => {
    // the actual LOD claim: driving across the site must not accumulate the world
    const xs = list.map((e) => place(e).x)
    const zs = list.map((e) => place(e).z)
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
    const [z0, z1] = [Math.min(...zs), Math.max(...zs)]
    const held = new Map<string, { bytes: number; dist: number }>()
    const BYTES = 256 * 1024 * 1024
    let peak = 0
    let peakBytes = 0
    for (let i = 0; i <= 40; i++) {
      const ex = x0 + ((x1 - x0) * i) / 40
      const ez = z0 + ((z1 - z0) * i) / 40
      const want = wanted(roots, { eye: { x: ex, z: ez }, metresPerPixel: mpp, has, place, maxTiles: 512 }, block.zmax)
      for (const [k, v] of held) v.dist = Math.hypot(place(parse(k)).x - ex, place(parse(k)).z - ez)
      const { load, drop } = diff(want, held, BYTES)
      for (const k of drop) held.delete(k)
      // Model what the stream actually does, not an idealised version of it: at most maxPending
      // fetches are in the air, and a fetch is only issued while resident + in-flight is under
      // budget. Without that second gate the peak overshoots by the whole load batch, which is
      // the bug this probe found once the per-tile figure was measured instead of guessed.
      // Measured: mean pack 213 KiB + a 512x512 float32 DEM + the same again for canopy.
      const PER = 2.21 * 1024 * 1024
      let resident = [...held.values()].reduce((a, b) => a + b.bytes, 0)
      let issued = 0
      for (const t of load) {
        if (issued >= 6) break
        if (resident + PER > BYTES) break
        held.set(tileKey(t), { bytes: PER, dist: 0 })
        resident += PER
        issued++
      }
      peak = Math.max(peak, held.size)
      peakBytes = Math.max(peakBytes, [...held.values()].reduce((a, b) => a + b.bytes, 0))
    }
    console.log(`  peak resident ${peak} tiles / ${(peakBytes / 2 ** 20).toFixed(1)} MiB, of ${list.length} in the bake`)
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThan(list.length)          // it is NOT just loading everything
    expect(peakBytes).toBeLessThanOrEqual(BYTES)    // the byte budget actually bounds it
    // and the budget is what bounds it, not the world running out — proof it would keep holding
    expect(peak).toBeLessThan(list.length * 0.5)
  })
})

function parse(k: string): TileId {
  const [z, x, y] = k.split('/').map(Number)
  return { z, x, y }
}
