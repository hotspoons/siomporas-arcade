#!/usr/bin/env node
// The sky's datasets, ingested — not fetched once by hand and forgotten.
//
// Rich, 2026-09-27: "Make sure any dataset we have an ingestion pipeline for, not just a one off."
//
// So every source the sky draws from is declared here as DATA, with one code path that fetches it,
// caches it, parses it, writes the asset, records where it came from, and checks the result
// against something true independently of the parser. Adding the next sky dataset is a new entry
// in SOURCES, not a new script.
//
//   node tools/sky/ingest.mjs                 # everything missing or stale
//   node tools/sky/ingest.mjs --only stars    # one source
//   node tools/sky/ingest.mjs --refresh       # re-fetch even if cached
//   node tools/sky/ingest.mjs --verify        # check the built assets, fetch nothing
//   node tools/sky/ingest.mjs --prove         # the checks, against deliberately broken input
//
// WHAT IT GUARANTEES
//
//   - the download is CACHED under ext/sky-cache, so a re-run costs nothing and a network
//     outage does not stop a build;
//   - every asset carries a `.json` beside it with the source URL, the fetch time, the SHA-256 of
//     what was downloaded, and the credit line the viewer must display;
//   - every source has a `verify` that would fail on a wrong answer, and `--prove` feeds each one
//     a broken input to show the check can go red. A check that cannot fail is decoration.
//
// WHY THE ASSETS ARE COMMITTED. They are small (about 110 kB), they never change — a star
// catalogue from 1991 is not going to be revised — and a client served from a Worker should not
// have to reach a university's FTP server to draw the sky.

import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const OUT = path.join(REPO, 'apps/corridor/public/assets/sky')
const CACHE = path.join(REPO, 'ext/sky-cache')

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? (process.argv[i + 1]?.startsWith('--') ? true : (process.argv[i + 1] ?? true)) : false
}

/* ---- the sources -------------------------------------------------------------------------- */

const col = (l, a, b) => l.slice(a - 1, b)

const SOURCES = [
  {
    id: 'stars',
    label: 'Bright Star Catalogue (BSC5)',
    url: 'http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz',
    gunzip: true,
    asset: 'stars.bin',
    credit: 'Star positions: Yale Bright Star Catalogue (Hoffleit & Warren 1991)',
    note:
      'Every star brighter than about magnitude 6.5 — precisely the set a person can see. ' +
      'Fixed-width ASCII; the column positions below are the catalogue ReadMe’s own and are ' +
      'checked against Sirius by `verify`.',
    /** J2000 is used unchanged: precession is under a degree a century, far below anything here. */
    parse(text) {
      const stars = []
      let skipped = 0
      for (const l of text.split('\n')) {
        if (l.length < 115) continue
        const rah = col(l, 76, 77).trim()
        // A BSC5 row with no position is a NOVA OR A DELETED ENTRY — the catalogue keeps the
        // numbering and blanks the row. Fourteen of them. Reading those as RA 0 would stack
        // fourteen stars on the vernal equinox.
        if (!rah) { skipped++; continue }
        const ra = ((Number(rah) + Number(col(l, 78, 79)) / 60 + Number(col(l, 80, 83)) / 3600) * 15 * Math.PI) / 180
        const sgn = col(l, 84, 84) === '-' ? -1 : 1
        const dec = (sgn * (Number(col(l, 85, 86)) + Number(col(l, 87, 88)) / 60 + Number(col(l, 89, 90)) / 3600) * Math.PI) / 180
        const mag = Number(col(l, 103, 107))
        if (!Number.isFinite(ra) || !Number.isFinite(dec) || !Number.isFinite(mag)) { skipped++; continue }
        const bvRaw = col(l, 110, 114).trim()
        const bv = Number(bvRaw)
        stars.push({ ra, dec, mag, bv: Number.isFinite(bv) ? bv : 0 })
      }
      stars.sort((a, b) => a.mag - b.mag)
      const buf = Buffer.alloc(stars.length * 12)
      stars.forEach((s, i) => {
        const o = i * 12
        buf.writeFloatLE(s.ra, o)
        buf.writeFloatLE(s.dec, o + 4)
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s.mag * 100))), o + 8)
        buf.writeInt8(Math.max(-128, Math.min(127, Math.round(s.bv * 50))), o + 10)
        buf.writeInt8(0, o + 11)
      })
      const mags = stars.map((s) => s.mag)
      return {
        buf,
        meta: {
          count: stars.length,
          skipped,
          magMin: +Math.min(...mags).toFixed(2),
          magMax: +Math.max(...mags).toFixed(2),
          bytesPerStar: 12,
          order: 'brightest first',
          fields: ['ra float32 rad J2000', 'dec float32 rad J2000', 'mag int16 x100', 'bv int8 x50', 'pad int8'],
        },
      }
    },
    /**
     * Three stars whose positions are known to anyone with a star chart, found by nearest
     * neighbour in the PACKED asset — so this checks the fetch, the column positions, the
     * radian conversion and the byte packing in one go, against numbers that owe nothing to
     * any of them.
     */
    verify(buf) {
      const n = buf.length / 12
      if (!n || n % 1) return { ok: false, why: `asset is ${buf.length} bytes, not a whole number of 12-byte stars` }
      const want = [
        { name: 'Sirius', raH: 6.7524, dec: -16.7161, mag: -1.46 },
        { name: 'Vega', raH: 18.6156, dec: 38.7837, mag: 0.03 },
        { name: 'Polaris', raH: 2.5303, dec: 89.2641, mag: 1.97 },
      ]
      let worst = 0
      const lines = []
      for (const w of want) {
        let best = null
        for (let i = 0; i < n; i++) {
          const raH = (buf.readFloatLE(i * 12) * 180) / Math.PI / 15
          const dec = (buf.readFloatLE(i * 12 + 4) * 180) / Math.PI
          const mag = buf.readInt16LE(i * 12 + 8) / 100
          const d = Math.hypot((raH - w.raH) * 15 * Math.cos((dec * Math.PI) / 180), dec - w.dec)
          if (!best || d < best.d) best = { d, mag }
        }
        const arcmin = best.d * 60
        worst = Math.max(worst, arcmin)
        lines.push(`${w.name} ${arcmin.toFixed(2)}' mag ${best.mag}`)
      }
      // one arcminute is about the sharpest a human eye resolves; anything under it is exact here
      return { ok: worst < 1, why: `worst ${worst.toFixed(2)} arcmin`, detail: lines.join(', ') }
    },
    /** what `--prove` feeds it: the same catalogue with the declination sign column blanked */
    break: (text) => text.split('\n').map((l) => (l.length > 115 ? l.slice(0, 83) + ' ' + l.slice(84) : l)).join('\n'),
  },
]

/* ---- the pipeline ------------------------------------------------------------------------- */

const sha = (b) => createHash('sha256').update(b).digest('hex')

async function download(src, refresh) {
  await mkdir(CACHE, { recursive: true })
  const cached = path.join(CACHE, path.basename(new URL(src.url).pathname))
  if (!refresh) {
    const hit = await readFile(cached).catch(() => null)
    if (hit) return { raw: hit, cached: true, file: cached }
  }
  const res = await fetch(src.url)
  if (!res.ok) throw new Error(`${src.url}: ${res.status}`)
  const raw = Buffer.from(await res.arrayBuffer())
  await writeFile(cached, raw)
  return { raw, cached: false, file: cached }
}

const gunzip = (raw) =>
  new Promise((resolve, reject) => {
    const chunks = []
    const z = createGunzip()
    z.on('data', (c) => chunks.push(c))
    z.on('end', () => resolve(Buffer.concat(chunks)))
    z.on('error', reject)
    z.end(raw)
  })

async function build(src, { refresh = false } = {}) {
  const { raw, cached, file } = await download(src, refresh)
  const text = (src.gunzip ? await gunzip(raw) : raw).toString('latin1')
  const { buf, meta } = src.parse(text)
  const v = src.verify(buf)
  if (!v.ok) throw new Error(`${src.id}: built asset failed its own check — ${v.why}`)
  await mkdir(OUT, { recursive: true })
  await writeFile(path.join(OUT, src.asset), buf)
  await writeFile(
    path.join(OUT, `${src.asset.replace(/\.[^.]+$/, '')}.json`),
    JSON.stringify(
      {
        ...meta,
        asset: src.asset,
        bytes: buf.length,
        source: src.label,
        sourceUrl: src.url,
        sourceSha256: sha(raw),
        credit: src.credit,
        note: src.note,
        fetched: new Date().toISOString(),
        tool: 'tools/sky/ingest.mjs',
      },
      null,
      1,
    ),
  )
  return { cached, file, bytes: buf.length, meta, v }
}

const only = arg('only')
const picked = SOURCES.filter((s) => !only || s.id === only)
if (!picked.length) { console.error(`no such source: ${only}`); process.exit(2) }

if (arg('verify')) {
  let bad = 0
  for (const s of picked) {
    const buf = await readFile(path.join(OUT, s.asset)).catch(() => null)
    if (!buf) { console.error(`  MISSING ${s.asset} — run the ingest`); bad++; continue }
    const v = s.verify(buf)
    console.log(`  ${v.ok ? 'ok  ' : 'FAIL'} ${s.id}: ${v.detail ?? ''} (${v.why})`)
    if (!v.ok) bad++
  }
  process.exit(bad ? 1 : 0)
}

if (arg('prove')) {
  let bad = 0
  for (const s of picked) {
    if (!s.break) { console.log(`  SKIP ${s.id}: no negative defined`); continue }
    const { raw } = await download(s, false)
    const text = (s.gunzip ? await gunzip(raw) : raw).toString('latin1')
    let red = false
    try {
      const { buf } = s.parse(s.break(text))
      red = !s.verify(buf).ok
    } catch {
      red = true
    }
    console.log(`  ${red ? 'ok  ' : 'FAIL'} [negative] ${s.id} ${red ? 'went red on a broken catalogue' : 'stayed GREEN on a broken catalogue — the check asserts nothing'}`)
    if (!red) bad++
  }
  process.exit(bad ? 1 : 0)
}

for (const s of picked) {
  const r = await build(s, { refresh: !!arg('refresh') })
  console.log(`  ${s.id}: ${JSON.stringify(r.meta.count ?? '')} from ${s.label}${r.cached ? ' (cached)' : ''}`)
  console.log(`         ${(r.bytes / 1024).toFixed(0)} kB -> assets/sky/${s.asset}   ${r.v.detail}`)
}
