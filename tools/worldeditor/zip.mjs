// ZIP, by hand, because a world has to leave this machine in one file.
//
// Rich, 2026-09-27: "we should be able to import and export world definitions and upload and
// download baked worlds in zip files as well as directly publish to a bucket."
//
// Node ships deflate and not zip, and the rest of this service has no dependencies on purpose —
// it runs in a pod whose whole job is to be small. A zip is a handful of little-endian records
// around deflated bytes, so it is written here: about a hundred lines against a dependency and
// its transitive tree.
//
// WHAT IS DELIBERATELY NOT HERE: zip64, encryption, and data descriptors. A baked world is
// hundreds of megabytes of PNG, JPEG and KTX2 — already compressed — so entries are STORED rather
// than deflated unless they compress, sizes are known before the header is written, and the
// 4 GiB limit is far away. If a world ever passes 4 GiB this file must grow zip64 rather than
// silently truncate, so `zipWrite` refuses instead.

import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib'

const LIMIT = 0xfffffffe // where zip64 would be needed; refuse rather than wrap

/** DOS time and date, which is what a zip stores. Two-second resolution, since 1980. */
function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31)
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  return { time, date }
}

/**
 * Build a zip from `[{ name, data, mtime? }]`. `name` uses forward slashes and no leading one.
 *
 * Each entry is deflated only if that actually makes it smaller: a JPEG or a KTX2 comes out of
 * deflate slightly LARGER, and storing it saves the CPU as well as the bytes.
 */
export function zipWrite(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(String(e.name).replace(/^\/+/, ''), 'utf8')
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data)
    if (data.length > LIMIT) throw new Error(`${e.name} is ${data.length} bytes: this writer has no zip64`)
    const deflated = data.length > 512 ? deflateRawSync(data, { level: 6 }) : null
    const store = !deflated || deflated.length >= data.length
    const body = store ? data : deflated
    const method = store ? 0 : 8
    const crc = crc32(data) >>> 0
    const { time, date } = dosTime(e.mtime ? new Date(e.mtime) : new Date())

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    chunks.push(local, name, body)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4) // version made by
    cen.writeUInt16LE(20, 6) // version needed
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(time, 12)
    cen.writeUInt16LE(date, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, name)

    offset += local.length + name.length + body.length
    if (offset > LIMIT) throw new Error('archive is over 4 GiB: this writer has no zip64')
  }
  const cdir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdir, end])
}

/**
 * Read a zip into `[{ name, data }]`, THROUGH THE CENTRAL DIRECTORY.
 *
 * Not by scanning for local headers: a local header may carry zeroed sizes with the real ones in a
 * trailing data descriptor, and the central directory is the only place a zip is required to be
 * truthful about what it contains. It is also where a path traversal would be hiding, so names are
 * checked here rather than by the caller.
 */
export function zipRead(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory entry ${i} is malformed`)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const elen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nlen)
    p += 46 + nlen + elen + clen
    if (name.endsWith('/')) continue // a directory entry carries no data
    // THE NAME IS NOT TO BE TRUSTED. `../` and absolute paths in an archive are the oldest
    // unpacking bug there is, and this one unpacks onto a volume the viewer serves.
    if (name.startsWith('/') || name.includes('..') || name.includes('\\') || /[\0]/.test(name)) {
      throw new Error(`refusing the entry "${name}": a path that could escape the destination`)
    }
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: local header is malformed`)
    const lnlen = buf.readUInt16LE(local + 26)
    const lelen = buf.readUInt16LE(local + 28)
    const start = local + 30 + lnlen + lelen
    const raw = buf.subarray(start, start + csize)
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
    if (data.length !== usize) throw new Error(`${name}: ${data.length} bytes where the directory says ${usize}`)
    if ((crc32(data) >>> 0) !== crc) throw new Error(`${name}: checksum does not match — the archive is damaged`)
    out.push({ name, data })
  }
  return out
}
