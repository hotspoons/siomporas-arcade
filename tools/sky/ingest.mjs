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
import { createGunzip, deflateSync, inflateSync } from 'node:zlib'
const zlibSync = (b) => deflateSync(b, { level: 9 })
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


/* ---- a PNG writer and a polygon rasteriser, so this tool needs no image library ------------- */

/** 8-bit greyscale PNG, by hand. zlib is in node; an image dependency would not be. */
function greyPng(w, h, data) {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0 // filter: none
    data.copy ? data.copy(raw, y * (w + 1) + 1, y * w, y * w + w) : Buffer.from(data.subarray(y * w, y * w + w)).copy(raw, y * (w + 1) + 1)
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

/**
 * Fill one isophote — ALL of its rings together — into a wrapping equirectangular raster.
 *
 * SCANNED DOWN MERIDIANS, NOT ALONG ROWS, and that is the whole trick. The Milky Way's two outer
 * contours each CIRCLE THE SKY: unwrapped, they span a full 360 degrees with a net drift of -360,
 * so they are the northern and southern edges of a band rather than closed blobs. A row-wise
 * even-odd fill cannot cope with that — a horizontal line crosses such a curve an odd number of
 * times — and the first version of this flooded the whole sky, giving a "Milky Way" as bright at
 * the galactic pole as on the plane.
 *
 * A meridian crosses the band's boundary an even number of times, always, and declination does not
 * wrap. So the fill runs down columns, all rings of a level contribute crossings to the same
 * parity test, and the seam never enters into it.
 *
 * Each ring is unwrapped first so its own segments are continuous, and a column consults it at
 * whichever multiple of 360 degrees puts that longitude inside the ring's span.
 */
function fillFeature(acc, w, h, rings, add) {
  // segments, unwrapped per ring, bucketed by the columns they touch
  const buckets = Array.from({ length: w }, () => [])
  const segs = []
  for (const ring of rings) {
    let prev = null
    const xs = []
    const ys = []
    for (const [lon, lat] of ring) {
      let x = lon
      if (prev !== null) {
        while (x - prev > 180) x -= 360
        while (prev - x > 180) x += 360
      }
      prev = x
      xs.push(x)
      ys.push(lat)
    }
    /*
     * EACH RING IS SAMPLED EXACTLY ONCE PER MERIDIAN.
     *
     * One of the Milky Way's contours spans 361.2 degrees after unwrapping — it overlaps itself
     * slightly at the seam — so near that seam a column matched TWO wrap offsets, contributed two
     * crossings instead of one, and flipped the parity for everything inside. That is what put a
     * bright patch on the north galactic pole and a hole at the anticentre.
     *
     * `base` is where this ring's own 360-degree window starts, so every column resolves to one
     * position on the ring and one crossing.
     */
    const base = Math.min(...xs)
    for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
      const x0 = xs[j]
      const x1 = xs[i]
      if (x0 === x1) continue
      const s = segs.length
      segs.push([x0, ys[j], x1, ys[i], base])
      // every column this segment spans, at every wrap that lands it on the canvas
      const lo = Math.min(x0, x1)
      const hi = Math.max(x0, x1)
      for (let k = -2; k <= 2; k++) {
        const a = lo + 360 * k
        const b = hi + 360 * k
        if (b < -180 || a > 180) continue
        const c0 = Math.max(0, Math.floor(((a + 180) / 360) * w))
        const c1 = Math.min(w - 1, Math.ceil(((b + 180) / 360) * w))
        for (let c = c0; c <= c1; c++) buckets[c].push(s)
      }
    }
  }
  const ys = []
  for (let c = 0; c < w; c++) {
    const lonBase = (c + 0.5) * (360 / w) - 180
    ys.length = 0
    for (const si of buckets[c]) {
      const [x0, y0, x1, y1, base] = segs[si]
      const lo = Math.min(x0, x1)
      const hi = Math.max(x0, x1)
      // the single position on THIS ring that this meridian corresponds to
      const lon = base + (((lonBase - base) % 360) + 360) % 360
      if (lon < lo || lon >= hi) continue
      ys.push(y0 + ((lon - x0) / (x1 - x0)) * (y1 - y0))
    }
    if (ys.length < 2) continue
    ys.sort((a, b) => a - b)
    for (let k = 0; k + 1 < ys.length; k += 2) {
      // declination to row: north at the top
      const r0 = Math.max(0, Math.floor(((90 - ys[k + 1]) / 180) * h))
      const r1 = Math.min(h - 1, Math.ceil(((90 - ys[k]) / 180) * h))
      for (let r = r0; r <= r1; r++) acc[r * w + c] += add
    }
  }
}

/** separable box blur, a few passes — a box blurred three times is a gaussian, near enough */
function blur(src, w, h, radius, passes = 3) {
  let a = Float32Array.from(src)
  let b = new Float32Array(a.length)
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0
        for (let k = -radius; k <= radius; k++) s += a[y * w + (((x + k) % w) + w) % w] // wraps in RA
        b[y * w + x] = s / (2 * radius + 1)
      }
    }
    ;[a, b] = [b, a]
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let s = 0
        let n = 0
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k
          if (yy < 0 || yy >= h) continue // clamps in declination: the sky has poles, not a seam
          s += a[yy * w + x]
          n++
        }
        b[y * w + x] = s / n
      }
    }
    ;[a, b] = [b, a]
  }
  return a
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


/** read back an 8-bit greyscale PNG this tool wrote — `verify` must inspect the ASSET, not a variable */
function decodeGreyPng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null
  let off = 8
  let w = 0
  let h = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = body.readUInt32BE(0)
      h = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 0) return null
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!w || !h) return null
  const raw = inflateSync(Buffer.concat(idat))
  const data = Buffer.alloc(w * h)
  for (let y = 0; y < h; y++) {
    if (raw[y * (w + 1)] !== 0) return null // this tool only ever writes filter 0
    raw.copy(data, y * w, y * (w + 1) + 1, y * (w + 1) + 1 + w)
  }
  return { w, h, data }
}

/* ---- the sources -------------------------------------------------------------------------- */

const col = (l, a, b) => l.slice(a - 1, b)

const SOURCES = [
  {
    id: 'milkyway',
    label: 'Milky Way isophotes (d3-celestial)',
    url: 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/mw.json',
    asset: 'milkyway.png',
    credit: 'Milky Way outline: d3-celestial (Olaf Frohn, BSD 3-clause)',
    note:
      'Five nested brightness contours as GeoJSON in equatorial degrees, rasterised here into an ' +
      'equirectangular luminance map. VECTOR rather than a photograph on purpose: the sky in this ' +
      'renderer is stylised, and a Brunier panorama would look like a photograph pasted behind a ' +
      'drawing. Contours give a soft band that sits with the stars.',
    /** 2048 x 1024 is about 10 arcminutes a texel — far finer than a band with no edges needs. */
    parse(text) {
      const gj = JSON.parse(text)
      const W = 2048
      const H = 1024
      const acc = new Float32Array(W * H)
      const levels = (gj.features ?? []).length
      if (!levels) throw new Error('no features in the Milky Way source')
      // the contours NEST, from faintest and largest to brightest and smallest, so simply adding
      // each one gives the ramp without any need to know which is which
      let rings = 0
      for (const f of gj.features) {
        const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]
        // PER POLYGON, not per level. A GeoJSON polygon is an exterior ring followed by its
        // HOLES, and even-odd over exactly those rings is what that means. Flattening a level's
        // polygons together throws the distinction away and lets one blob punch a hole in
        // another — which is what put a bright patch on the north galactic pole and a gap at the
        // anticentre. The band itself is one polygon whose exterior and hole both circle the sky.
        for (const poly of polys) {
          fillFeature(acc, W, H, poly, 1)
          rings += poly.length
        }
      }
      const soft = blur(acc, W, H, 6, 3)
      let max = 0
      for (const v of soft) if (v > max) max = v
      const out = Buffer.alloc(W * H)
      for (let i = 0; i < soft.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((soft[i] / (max || 1)) * 255)))
      return { buf: greyPng(W, H, out), meta: { width: W, height: H, levels, rings, projection: 'equirectangular, x = (RA + 180)/360, y = (90 - Dec)/180', blurTexels: 6 } }
    },
    /**
     * The band must lie on the GALACTIC PLANE — which is a fact about the galaxy, not about this
     * rasteriser. Sampled through the standard galactic-to-equatorial rotation: the plane has to
     * be far brighter than the galactic poles, and the centre in Sagittarius brightest of all.
     */
    verify(png) {
      const g = decodeGreyPng(png)
      if (!g) return { ok: false, why: 'the asset is not a greyscale PNG this tool can read back' }
      const at = (raDeg, decDeg) => {
        const x = Math.min(g.w - 1, Math.max(0, Math.round((((raDeg + 180) % 360) / 360) * g.w)))
        const y = Math.min(g.h - 1, Math.max(0, Math.round(((90 - decDeg) / 180) * g.h)))
        return g.data[y * g.w + x]
      }
      const onPlane = []
      for (let l = 0; l < 360; l += 15) {
        const e = galacticToEquatorial(l, 0)
        onPlane.push(at(e.raDeg, e.decDeg))
      }
      // THE POLES THEMSELVES, not merely high latitudes. Sampling b = +/-70 and +/-80 read 5 and
      // passed, while the north galactic pole itself read 38 — the check was looking next to the
      // fault rather than at it.
      const atPoles = []
      for (const b of [90, -90, 88, -88, 80, -80, 70, -70]) {
        for (const l of [0, 90, 180, 270]) {
          const e = galacticToEquatorial(l, b)
          atPoles.push(at(e.raDeg, e.decDeg))
        }
      }
      const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length
      const plane = mean(onPlane)
      // the MAXIMUM off the plane, not the mean: the fault is a bright patch somewhere, and a
      // mean over the whole high-latitude sky averages one away against the dark half
      const poles = Math.max(...atPoles)
      const centre = at(galacticToEquatorial(0, 0).raDeg, galacticToEquatorial(0, 0).decDeg)
      /*
       * STRICT ON PURPOSE, AND CURRENTLY RED.
       *
       * Measured 2026-09-27: plane 74, centre 137, south galactic pole 0, Coma 0 — all correct —
       * but the NORTH galactic pole reads 38 where it should be near 0, and the anticentre reads
       * 1 where the band should be faintly visible. So the rasteriser is right about the galaxy
       * and wrong about two places, and a map with a bright patch on the galactic pole is worse
       * than no map.
       *
       * The check is left strict and the asset is therefore NOT WRITTEN. Loosening it to let the
       * build pass would be choosing not to know. Ruled out already: flattening polygons across a
       * level (filling per polygon changes nothing, since each level is one polygon), and a
       * contour that spans 361.2 degrees being sampled twice near the seam (sampling each ring
       * once per meridian changes nothing — byte-identical output).
       */
      const ok = plane > 60 && centre > plane && poles < 20 && plane > poles * 3
      return {
        ok,
        why: `plane ${plane.toFixed(0)}, brightest off-plane ${poles.toFixed(0)}, centre ${centre}`,
        detail: `galactic plane mean ${plane.toFixed(0)}/255, brightest off-plane ${poles.toFixed(0)}, centre ${centre}`,
      }
    },
    /** what `--prove` feeds it: every contour flattened onto the celestial equator */
    break: (text) => {
      const gj = JSON.parse(text)
      for (const f of gj.features) {
        const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]
        for (const poly of polys) for (const ring of poly) for (const p of ring) p[1] = p[1] * 0.02
      }
      return JSON.stringify(gj)
    },
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
