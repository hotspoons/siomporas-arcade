// Can a write be lost between the CPU array and the GPU?
//
// That is the whole question, and every wrong answer looks the same from outside: an impostor that
// is hidden in memory and still standing on the screen, intermittently, cleared by a reload.
// Rich reported exactly that; the cause was two writes in one frame where the second discarded the
// first's upload ranges, and a full re-seat that was demoted to a partial upload by the ranged
// write that came after it.
import { describe, expect, it } from 'vitest'
import { Uploads } from '../src/assets/uploads'

describe('Uploads', () => {
  it('starts with nothing pending', () => {
    const u = new Uploads()
    expect(u.pendingAll).toBe(false)
    expect(u.pendingRanges).toEqual([])
  })

  it('accumulates ranges across writes, and does NOT drop the earlier ones', () => {
    // the failure: `refreshFar` cleared at its start, and it runs twice in a frame whenever a
    // replant triggers one and the near set then moves
    const u = new Uploads()
    u.mark(16, 16)
    u.mark(48, 16)
    expect(u.pendingRanges).toEqual([{ start: 16, count: 16 }, { start: 48, count: 16 }])
  })

  it('lets a full rewrite swallow the ranges queued before it', () => {
    const u = new Uploads()
    u.mark(16, 16)
    u.markAll()
    expect(u.pendingAll).toBe(true)
    expect(u.pendingRanges).toEqual([])
  })

  it('refuses to narrow a pending full upload back to a range', () => {
    // THE OTHER HALF, and the worse one: to three, a non-empty range list means "send only these".
    // A range registered after a full rewrite turns that rewrite into a partial upload and every
    // other matrix it wrote never arrives.
    const u = new Uploads()
    u.markAll()
    u.mark(16, 16)
    u.mark(9999, 16)
    expect(u.pendingAll).toBe(true)
    expect(u.pendingRanges).toEqual([])
    expect(u.shouldRegister()).toBe(false)
  })

  it('goes back to ranges once the full upload has actually happened', () => {
    const u = new Uploads()
    u.markAll()
    u.uploaded()
    expect(u.shouldRegister()).toBe(true)
    u.mark(32, 16)
    expect(u.pendingRanges).toEqual([{ start: 32, count: 16 }])
  })

  it('clears only on an upload, never on a frame', () => {
    // the upload happens when the renderer next draws this attribute, which is not the same as
    // "next frame" — a frame that culls the mesh does not upload it
    const u = new Uploads()
    u.mark(0, 16)
    u.mark(16, 16)
    expect(u.pendingRanges).toHaveLength(2)
    u.uploaded()
    expect(u.pendingRanges).toEqual([])
    expect(u.pendingAll).toBe(false)
  })

  it('survives the sequence that produced the bug', () => {
    // replant: a full re-seat, then refreshFar's ranged writes, then the near set moves and
    // refreshFar runs AGAIN — all before a single render
    const u = new Uploads()
    u.markAll()          // seatImpostors rewrote every matrix
    u.mark(16, 16)       // refreshFar hid one card
    u.mark(64, 16)       // and another
    expect(u.pendingAll, 'the seat must still be a full upload').toBe(true)
    u.mark(128, 16)      // the second refreshFar
    expect(u.pendingRanges, 'nothing may narrow it').toEqual([])
    u.uploaded()
    // and afterwards it is back to being cheap
    u.mark(16, 16)
    expect(u.pendingAll).toBe(false)
    expect(u.pendingRanges).toEqual([{ start: 16, count: 16 }])
  })
})

/**
 * What three.js would actually send, given a CPU array and a pending set.
 *
 * Modelled from `WebGLAttributes.updateBuffer` in three 0.185: with no update ranges it sends the
 * whole array; with ranges it sends only those. That one rule is the whole of the bug, and having
 * it here means the sequence can be replayed rather than reasoned about.
 */
function upload(cpu: number[], gpu: number[], u: Uploads): void {
  if (u.pendingAll || u.pendingRanges.length === 0) {
    for (let i = 0; i < cpu.length; i += 1) gpu[i] = cpu[i]
  } else {
    for (const r of u.pendingRanges) {
      for (let i = r.start; i < r.start + r.count; i += 1) gpu[i] = cpu[i]
    }
  }
  u.uploaded()
}

describe('the tally', () => {
  it('says every write reached the GPU when it did', () => {
    const u = new Uploads()
    u.mark(0, 16)
    u.mark(16, 16)
    u.uploaded()
    expect([u.marked, u.sent]).toEqual([2, 2])
  })

  it('counts a write made while a full upload was pending, because that upload carries it', () => {
    const u = new Uploads()
    u.markAll()
    u.mark(0, 16)
    u.mark(16, 16)
    u.uploaded()
    expect([u.marked, u.sent]).toEqual([2, 2])
  })

  it('DIVERGES when a write is dropped, which is the only visible sign of the bug', () => {
    // the CPU array is right, every counter computed from it is right, and the screen is wrong
    const u = new Uploads()
    u.mark(0, 16)
    u.uploaded()   // pretend this was an app-side clear with no upload behind it
    u.sent -= 1    // which is what "the range was discarded" amounts to
    u.mark(16, 16)
    u.uploaded()
    expect(u.sent).toBeLessThan(u.marked)
  })
})

describe('the frame that produced the bug, replayed', () => {
  /** four impostor slots, one float each for the sake of the argument; 1 is up, 0 is hidden */
  const frame = (clearAtStart: boolean) => {
    const cpu = [1, 1, 1, 1]
    const gpu = [1, 1, 1, 1]
    const u = new Uploads()

    // the replant re-seats every matrix
    for (let i = 0; i < cpu.length; i += 1) cpu[i] = 1
    u.markAll()

    // refreshFar, first pass: slot 1 handed over to a procedural model
    if (clearAtStart) u.uploaded() // what `imp.clearRanges()` did
    cpu[1] = 0
    u.mark(1, 1)

    // the near set moves in the SAME frame, so refreshFar runs again
    if (clearAtStart) u.uploaded()
    cpu[2] = 0
    u.mark(2, 1)

    upload(cpu, gpu, u)
    return gpu
  }

  it('sends every hide to the GPU', () => {
    expect(frame(false)).toEqual([1, 0, 0, 1])
  })

  it('and would not have, when each pass cleared the ranges first', () => {
    // slot 1 is hidden in memory and still standing on the screen — which is the report:
    // intermittent, cleared by a reload, back again later
    const gpu = frame(true)
    expect(gpu[2], 'the last pass always arrived, which is why it looked random').toBe(0)
    expect(gpu[1], 'this is the card that stayed up').toBe(1)
  })
})
