// A capture: the footage a splat world is made from, and the run that turns it into one.
//
// Rich, 2026-09-27: "we'd want to upload one or more video chapters from one or more cameras and
// then have that be fed to the big job that kicks off. We'll need to support big file uploads to
// make this work."
//
// WHY THIS IS NOT THE ARCHIVE PATH. `zip.mjs` builds a whole archive in memory because a baked
// world is hundreds of megabytes and that is a stated, checked limit. Footage is not: a GoPro Max
// 2 writes a 4 GB chapter every few minutes and a neighbourhood is tens of them. Nothing here ever
// holds a file in memory — the body streams to disk as it arrives, and the only thing kept is an
// offset.
//
// RESUMABLE, because a 40 GB upload over a home connection will be interrupted and starting again
// is not an answer. The protocol is the smallest thing that survives it:
//
//     POST /api/captures/<id>/chapters   { camera, name, bytes }  -> { upload, offset }
//     GET  /api/uploads/<upload>                                  -> { offset, bytes }
//     PUT  /api/uploads/<upload>   Content-Range: bytes N-M/TOTAL -> { offset }
//     POST /api/uploads/<upload>/done                             -> the chapter record
//
// A client that dies mid-PUT asks for the offset and continues from it. The server appends only
// at the offset it already has, so a confused client cannot interleave two ranges into a corrupt
// file: a PUT whose range does not start where the file ends is refused with the offset it
// should have used.

import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/

/*
 * GOPRO NAMES A FILE `GS<chapter><recording>.360` — CHAPTER FIRST, RECORDING LAST.
 *
 * So sorting by name is chronological within one recording and silently interleaved across
 * several. The splats lane caught this before the first multi-recording capture:
 *
 *     GS010002  GS020002  GS030002     recording 0002, chapters 1, 2, 3      correct
 *     GS010002  GS010003  GS020002     ch1 of rec2, ch1 of rec3, ch2 of rec2 WRONG
 *
 * What it costs them is not obvious, which is why it would have gone unnoticed: chunking is
 * spatial, so frames land in the right cells regardless, but pass splitting works on gaps in time
 * and source video, so a shuffled order invents pass boundaries and quietly degrades every
 * per-pass diagnostic built on them.
 */
const GOPRO = /^G[A-Z](\d{2})(\d{4})\.(360|mp4|lrv)$/i

/**
 * A sort key that is chronological across recordings as well as within one.
 *
 * `[recording, chapter]` where the name says so, and the upload order otherwise — because a name
 * we cannot parse is a name we must not guess at, and the order a person added the files is a
 * better guess than alphabetical.
 */
export function chapterOrder(ch, i = 0) {
  const m = GOPRO.exec(ch.name ?? '')
  if (m) return [0, Number(m[2]), Number(m[1]), ch.name]
  return [1, ch.index ?? i, 0, ch.name ?? '']
}

const byOrder = (a, b) => {
  const ka = chapterOrder(a, a.index ?? 0)
  const kb = chapterOrder(b, b.index ?? 0)
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
  return 0
}
/** a chapter file name: no directories, no surprises, and an extension we know is video */
const CHAPTER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(mp4|mov|insv|360|mkv|lrv)$/i

export class Captures {
  constructor(root) {
    this.root = path.join(path.resolve(root), 'captures')
    this.uploads = path.join(path.resolve(root), 'uploads')
  }

  async init() {
    await mkdir(this.root, { recursive: true })
    await mkdir(this.uploads, { recursive: true })
  }

  dir(id) {
    if (!SLUG.test(id)) return null
    return path.join(this.root, id)
  }

  async list() {
    const out = []
    for (const d of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue
      const c = await this.get(d.name)
      if (c) out.push(c)
    }
    return out.sort((a, b) => (a.created < b.created ? 1 : -1))
  }

  async get(id) {
    const d = this.dir(id)
    if (!d) return null
    try {
      return JSON.parse(await readFile(path.join(d, 'capture.json'), 'utf8'))
    } catch {
      return null
    }
  }

  async put(capture) {
    const d = this.dir(capture.id)
    if (!d) throw Object.assign(new Error(`"${capture.id}" is not a usable capture id`), { status: 400 })
    await mkdir(d, { recursive: true })
    const tmp = path.join(d, `.capture.${randomUUID().slice(0, 8)}`)
    await writeFile(tmp, JSON.stringify(capture, null, 1))
    await rename(tmp, path.join(d, 'capture.json'))
    return capture
  }

  /** Create a capture. `world` is the slug it will be attached to, and may be set later. */
  async create({ id, world = null, note = '', rig = null }) {
    if (!SLUG.test(id ?? '')) throw Object.assign(new Error(`"${id}" is not a usable capture id`), { status: 400 })
    if (await this.get(id)) throw Object.assign(new Error(`capture ${id} already exists`), { status: 409 })
    return this.put({ id, world, note, rig, created: new Date().toISOString(), state: 'collecting', chapters: [] })
  }

  /**
   * Begin a chapter upload. Returns the upload id and the offset to start at — which is not
   * always zero: asking twice for the same chapter RESUMES it rather than starting a second one,
   * because "I lost my connection and clicked upload again" is the common case, not an error.
   */
  async beginChapter(captureId, { camera, name, bytes }) {
    const capture = await this.get(captureId)
    if (!capture) throw Object.assign(new Error(`no capture ${captureId}`), { status: 404 })
    if (!SLUG.test(camera ?? '')) throw Object.assign(new Error(`"${camera}" is not a usable camera name (lower case, digits, dashes)`), { status: 400 })
    if (!CHAPTER.test(name ?? '')) throw Object.assign(new Error(`"${name}" is not a chapter file name this accepts`), { status: 400 })
    const total = Number(bytes)
    if (!Number.isFinite(total) || total <= 0) throw Object.assign(new Error('bytes must be the chapter size'), { status: 400 })

    const existing = capture.chapters.find((c) => c.camera === camera && c.name === name)
    if (existing?.complete) throw Object.assign(new Error(`${camera}/${name} is already uploaded`), { status: 409 })
    const upload = existing?.upload ?? `${captureId}--${camera}--${name}`.replace(/[^A-Za-z0-9._-]/g, '_')
    const part = path.join(this.uploads, `${upload}.part`)
    const at = await stat(part).then((s) => s.size).catch(() => 0)
    if (!existing) {
      // the order this chapter was ADDED, kept for names we cannot parse a recording out of
      capture.chapters.push({ camera, name, bytes: total, upload, offset: at, complete: false, index: capture.chapters.length })
      await this.put(capture)
    }
    return { upload, offset: at, bytes: total }
  }

  /** Where a partial upload lives, and how far it has got. */
  async uploadState(upload) {
    if (!/^[A-Za-z0-9._-]{1,255}$/.test(upload)) return null
    const part = path.join(this.uploads, `${upload}.part`)
    const offset = await stat(part).then((s) => s.size).catch(() => null)
    return offset === null ? { upload, offset: 0, exists: false, part } : { upload, offset, exists: true, part }
  }

  /**
   * Append a request body to an upload, at `offset`.
   *
   * STREAMED, and appended ONLY at the end of what is already there. A range that starts anywhere
   * else is refused with the offset it should have used, so a client that retries out of order
   * cannot punch a hole in the middle of a file and hand it to a training run four hours later.
   */
  async append(upload, offset, req) {
    const st = await this.uploadState(upload)
    if (!st) throw Object.assign(new Error('not a usable upload id'), { status: 400 })
    const want = Number(offset)
    if (!Number.isFinite(want) || want < 0) throw Object.assign(new Error('offset is required'), { status: 400 })
    if (want !== st.offset) {
      throw Object.assign(new Error(`this upload is at ${st.offset} bytes, not ${want}`), { status: 409, offset: st.offset })
    }
    await pipeline(req, createWriteStream(st.part, { flags: 'a' }))
    return this.uploadState(upload)
  }

  /** Finish a chapter: move the part into the capture and mark it complete. */
  async finishChapter(captureId, upload) {
    const capture = await this.get(captureId)
    if (!capture) throw Object.assign(new Error(`no capture ${captureId}`), { status: 404 })
    const ch = capture.chapters.find((c) => c.upload === upload)
    if (!ch) throw Object.assign(new Error(`capture ${captureId} has no chapter for upload ${upload}`), { status: 404 })
    const st = await this.uploadState(upload)
    if (!st?.exists) throw Object.assign(new Error(`nothing has been uploaded for ${upload}`), { status: 400 })
    // THE SIZE IS CHECKED. A truncated chapter is a training run that fails hours later, or worse,
    // one that succeeds on half the footage and nobody notices which half.
    if (st.offset !== ch.bytes) {
      throw Object.assign(new Error(`${ch.camera}/${ch.name} is ${st.offset} bytes of ${ch.bytes} — it is not finished`), { status: 409, offset: st.offset })
    }
    const dest = path.join(this.dir(captureId), 'video', ch.camera, ch.name)
    await mkdir(path.dirname(dest), { recursive: true })
    await rename(st.part, dest)
    ch.complete = true
    ch.offset = st.offset
    ch.uploaded = new Date().toISOString()
    await this.put(capture)
    return ch
  }

  async removeChapter(captureId, camera, name) {
    const capture = await this.get(captureId)
    if (!capture) throw Object.assign(new Error(`no capture ${captureId}`), { status: 404 })
    const i = capture.chapters.findIndex((c) => c.camera === camera && c.name === name)
    if (i < 0) throw Object.assign(new Error('no such chapter'), { status: 404 })
    const [ch] = capture.chapters.splice(i, 1)
    await rm(path.join(this.dir(captureId), 'video', ch.camera, ch.name), { force: true })
    await rm(path.join(this.uploads, `${ch.upload}.part`), { force: true })
    await this.put(capture)
    return ch
  }

  /** What the job needs to know: the footage on disk, per camera, in name order. */
  async manifest(captureId) {
    const capture = await this.get(captureId)
    if (!capture) return null
    const byCamera = {}
    for (const ch of capture.chapters) {
      if (!ch.complete) continue
      ;(byCamera[ch.camera] ??= []).push(ch)
    }
    for (const k of Object.keys(byCamera)) {
      // ORDERED HERE, AND THE ORDER IS PUBLISHED. The consumer must never sort this by name —
      // see chapterOrder — so each entry carries its place explicitly.
      byCamera[k].sort(byOrder)
      byCamera[k] = byCamera[k].map((ch, i) => {
        const m = GOPRO.exec(ch.name)
        return {
          order: i,
          name: ch.name,
          bytes: ch.bytes,
          path: `captures/${captureId}/video/${ch.camera}/${ch.name}`,
          ...(m ? { recording: Number(m[2]), chapter: Number(m[1]) } : { uploaded: ch.index ?? null }),
        }
      })
    }
    const complete = capture.chapters.filter((c) => c.complete)
    return {
      id: capture.id,
      world: capture.world,
      rig: capture.rig,
      cameras: byCamera,
      // said out loud, so nobody downstream reaches for a sort of their own
      ordering: 'explicit: use `order`. Sorting by name interleaves GoPro recordings (GS<chapter><recording>).',
      chapters: complete.length,
      pending: capture.chapters.length - complete.length,
      bytes: complete.reduce((n, c) => n + c.bytes, 0),
    }
  }
}
