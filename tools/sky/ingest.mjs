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
// WHY THE ASSETS ARE COMMITTED. The catalogue and the contours are small (about 110 kB), they
// never change — a star catalogue from 1991 is not going to be revised — and a client served from
// a Worker should not have to reach a university's FTP server to draw the sky. The real Milky Way
// raster is the exception at a few megabytes: it is a photograph of the galaxy and there is no
// way to hold one that small, so it is committed at a resolution the dome can actually use.

import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// THE RASTER SOURCE IS THE ONE EXCEPTION to "no image library". A star catalogue can be parsed
// with string and arithmetic; a 4k photographic galaxy cannot. So this source alone decodes its
// OpenEXR with three's EXRLoader (three is already a dependency of the app) and encodes the
// committed JPEG with sharp (already a root devDependency). Everything still runs under
// `node tools/sky/ingest.mjs` with no external binary.
import sharp from 'sharp'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const OUT = path.join(REPO, 'apps/corridor/public/assets/sky')
const CACHE = path.join(REPO, 'ext/sky-cache')

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? (process.argv[i + 1]?.startsWith('--') ? true : (process.argv[i + 1] ?? true)) : false
}


/** galactic (l, b) to equatorial J2000, for checking the band lies on the galactic plane */
function galacticToEquatorial(lDeg, bDeg) {
  const d2r = Math.PI / 180
  const NGP_RA = 192.85948 * d2r
  const NGP_DEC = 27.12825 * d2r
  const L_NCP = 122.93192 * d2r
  const l = lDeg * d2r
  const b = bDeg * d2r
  const sinDec = Math.sin(b) * Math.sin(NGP_DEC) + Math.cos(b) * Math.cos(NGP_DEC) * Math.cos(L_NCP - l)
  const dec = Math.asin(sinDec)
  const y = Math.cos(b) * Math.sin(L_NCP - l)
  const x = Math.sin(b) * Math.cos(NGP_DEC) - Math.cos(b) * Math.sin(NGP_DEC) * Math.cos(L_NCP - l)
  let ra = NGP_RA + Math.atan2(y, x)
  ra = ((ra % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return { raDeg: ra / d2r, decDeg: dec / d2r }
}


/* ---- the sources -------------------------------------------------------------------------- */

const col = (l, a, b) => l.slice(a - 1, b)

/* ---- the raster's colour maths, small and standalone so they can be checked ------------------ */

/** IEEE 754 half -> Number. three's EXRLoader hands back the raw Uint16 half-float samples. */
function halfToFloat(h) {
  const s = (h & 0x8000) >> 15
  const e = (h & 0x7c00) >> 10
  const f = h & 0x03ff
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024)
  if (e === 31) return f ? NaN : s ? -Infinity : Infinity
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024)
}

/** linear -> sRGB transfer. The 8-bit asset is sRGB-encoded so the faint band keeps its detail. */
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)))

/**
 * Where the empty sky is defined. The Deep Star Maps carries a faint all-sky floor and the whole
 * field of stars below the bright-catalogue limit; at the black point used here the true
 * background reads as exactly zero, so the band can be added to the dome and never drawn as a
 * dark sheet over it. The gain then opens the band back up for an 8-bit file.
 */
const MW_BLACK = 0.016
const MW_GAIN = 1.9

/**
 * A 3 x 3 median on each channel, run before the black point.
 *
 * The Deep Star Maps omits the BRIGHT stars, but it still carries every faint one, and at
 * thousands of them a megapixel they read as grain over the whole sky -- and they are stars this
 * renderer already draws from its own catalogue, so they are noise twice over. An isolated star
 * is one or two pixels; the galaxy is a structure tens of pixels wide, so a median window takes
 * the star and leaves the band. It also happens to remove most of the JPEG's high-frequency work:
 * the cleaned plate encodes about half the size of the raw one.
 */
function median3(src, W, H) {
  const out = new Float32Array(src.length)
  const w = new Float32Array(9)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let k = 0
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(H - 1, Math.max(0, y + dy))
          for (let dx = -1; dx <= 1; dx++) w[k++] = src[(yy * W + ((x + dx + W) % W)) * 3 + c]
        }
        for (let i = 1; i < 9; i++) { const v = w[i]; let j = i - 1; while (j >= 0 && w[j] > v) { w[j + 1] = w[j]; j-- } w[j + 1] = v }
        out[(y * W + x) * 3 + c] = w[4]
      }
    }
  }
  return out
}

const SOURCES = [
  {
    id: 'milkyway',
    label: 'Deep Star Maps 2020, Milky Way layer (NASA/Goddard SVS)',
    url: 'https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr',
    binary: true,
    asset: 'milkyway.jpg',
    credit:
      'Milky Way: NASA/Goddard Space Flight Center Scientific Visualization Studio (Ernie Wright). ' +
      'Gaia DR2: ESA/Gaia/DPAC.',
    note:
      'The galaxy as an actual image, not contours: Deep Star Maps 2020 in celestial coordinates, ' +
      'linear half-float OpenEXR, with the bright Hipparcos/Tycho stars removed by NASA precisely ' +
      'so a star map can be layered under its own catalogue. Decoded here from the 4k EXR, rotated ' +
      '180 degrees into this tool\'s equatorial convention (NASA centres on 0h with r.a. increasing ' +
      'to the LEFT and the file runs south-first; ours runs r.a. to the right, north-first), ' +
      'median-filtered to drop the faint stars NASA still leaves in, black-pointed so the empty sky ' +
      'is exactly zero, then sRGB-encoded. The zero background is what lets it be added to the dome ' +
      'instead of pasted over it, and the shader keys on luminance as well. JPEG rather than PNG: ' +
      'lossless colour here is tens of megabytes and the band is soft enough that it does not need ' +
      'them.',
    async parse(input) {
      // `--prove` hands back the raw EXR wrapped with `wrong`: this skips the rotation, so the
      // band lands on the wrong great circle and the galactic check must go red.
      const wrong = !Buffer.isBuffer(input)
      const raw = wrong ? input.raw : input
      const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      const exr = new EXRLoader().parse(ab)
      const W = exr.width
      const H = exr.height
      const src = exr.data // Uint16 half-float, RGBA
      // rotate into this tool's convention and un-half the samples first
      const lin = new Float32Array(W * H * 3)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const sx = wrong ? x : W - 1 - x
          const sy = wrong ? y : H - 1 - y
          const si = (sy * W + sx) * 4
          const o = (y * W + x) * 3
          lin[o] = halfToFloat(src[si])
          lin[o + 1] = halfToFloat(src[si + 1])
          lin[o + 2] = halfToFloat(src[si + 2])
        }
      }
      // the faint catalogue stars go first, then the empty sky is driven to zero, then the band
      // is opened back up for 8 bits
      const clean = median3(lin, W, H)
      const rgb = Buffer.alloc(W * H * 3)
      for (let i = 0, o = 0; i < W * H; i++, o += 3) {
        for (let c = 0; c < 3; c++) rgb[o + c] = clamp255(toSrgb(Math.max(0, (clean[o + c] - MW_BLACK) * MW_GAIN)))
      }
      const buf = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
        .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
        .toBuffer()
      return {
        buf,
        meta: {
          width: W,
          height: H,
          format: 'jpeg',
          blackPoint: MW_BLACK,
          gain: MW_GAIN,
          denoise: '3x3 median (drops the faint catalogue stars NASA leaves in)',
          projection: 'equirectangular, x = (RA + 180)/360, y = (90 - Dec)/180',
          rotationFromSource: wrong ? 'none (broken)' : '180 degrees',
        },
      }
    },
    /**
     * The band must lie on the GALACTIC PLANE, and the galactic centre in Sagittarius must be the
     * bright one. Both are facts about the galaxy, sampled through the standard galactic-to-
     * equatorial rotation, so a wrong flip or a wrong rotation fails even though the picture
     * still looks like a Milky Way. A JPEG is decoded with sharp (the one image library the tool
     * uses) and the checks run on its luminance.
     */
    async verify(buf) {
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { ok: false, why: 'the asset is not a JPEG' }
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
      const w = info.width
      const h = info.height
      const ch = info.channels
      const at = (raDeg, decDeg) => {
        const x = Math.min(w - 1, Math.max(0, Math.round(((((raDeg + 180) % 360) + 360) % 360) / 360 * w)))
        const y = Math.min(h - 1, Math.max(0, Math.round(((90 - decDeg) / 180) * h)))
        const o = (y * w + x) * ch
        return 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]
      }
      const atGal = (l, b) => {
        const e = galacticToEquatorial(l, b)
        return at(e.raDeg, e.decDeg)
      }
      const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length
      // 1. the plane is bright
      const onPlane = []
      for (let l = 0; l < 360; l += 15) onPlane.push(atGal(l, 0))
      const plane = mean(onPlane)
      // 2. the centre in Sagittarius is the brightest part of it, and brighter than the anticentre
      const centre = atGal(0, 0)
      const anticentre = atGal(180, 0)
      // 3. the POLES are dark on average. A mean, not a maximum: a real raster has a bright star
      //    somewhere off the plane, and the fault this is looking for -- the band on the wrong
      //    great circle -- moves the whole band and lights up the average.
      const atPoles = []
      for (const b of [90, -90, 88, -88, 80, -80, 70, -70]) for (const l of [0, 45, 90, 135, 180, 225, 270, 315]) atPoles.push(atGal(l, b))
      const poles = mean(atPoles)
      // 4. the band closes all the way round: at every longitude there is SOMETHING bright within
      //    ten degrees of the plane. A minimum survives a faint anticentre; a mean would not.
      let thinnest = 255
      for (let l = 0; l < 360; l += 5) {
        let m = 0
        for (let b = -10; b <= 10; b++) m = Math.max(m, atGal(l, b))
        thinnest = Math.min(thinnest, m)
      }
      // 5. most of the sky is dark. Catches a flooded or inverted-keyed asset.
      let sum = 0
      for (let i = 0; i < data.length; i += ch) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
      const skyMean = sum / (w * h)
      const ok = plane > poles * 2 && plane > 50 && centre > plane && centre > anticentre * 1.15 && thinnest > 25 && skyMean < 45
      const why = `plane ${plane.toFixed(0)}, centre ${centre.toFixed(0)}, anticentre ${anticentre.toFixed(0)}, mean pole ${poles.toFixed(0)}, faintest along the band ${thinnest.toFixed(0)}, whole-sky mean ${skyMean.toFixed(0)}`
      return { ok, why, detail: why }
    },
    /** what `--prove` feeds it: the raw EXR with the orientation left off */
    break: (raw) => ({ raw, wrong: true }),
  },
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
  const payload = src.gunzip ? await gunzip(raw) : raw
  const input = src.binary ? payload : payload.toString('latin1')
  const { buf, meta } = await src.parse(input)
  const v = await src.verify(buf)
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
    const v = await s.verify(buf)
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
    const payload = s.gunzip ? await gunzip(raw) : raw
    const input = s.binary ? payload : payload.toString('latin1')
    let red = false
    try {
      const { buf } = await s.parse(s.break(input))
      red = !(await s.verify(buf)).ok
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
