// Rooms: the relay that lets friends share a Squishy Hunt.
//
// Rich's nine-year-old wants "her and her friends" in the same hunt. What that needs is small:
// each player's position and heading a few times a second, and a record of who claimed which
// squishy first. Nothing here is authoritative about physics, scores or the world; the world is
// the same bake on every machine, the hunt is the same seed, and the room only keeps the two
// things that differ between machines.
//
// No dependencies, like the rest of this service: the server pushes state over Server-Sent
// Events (one long GET per player) and players send their pose with plain POSTs. That is enough
// for a handful of kids on a LAN or through the tunnel, and it works everywhere fetch does. A
// WebSocket would halve the overhead and is a later change to this one file.
//
//   GET  /api/rooms/:room/events                SSE: `state` events, and a `ping` every 5 s
//   POST /api/rooms/:room/pose   {id, name, colour, pos, yaw}
//   POST /api/rooms/:room/claim  {id, haul}    -> {ok, by}   first claim wins
//   GET  /api/rooms                             the rooms and their player counts
//
// Rooms live in memory and a player who has not posted for STALE_MS drops out; an empty room is
// forgotten after a minute. Restarting the service ends every hunt, which is fine for a game.

const STALE_MS = 8_000
const EMPTY_MS = 60_000
const BROADCAST_MIN_MS = 100

const rooms = new Map()

function room(name) {
  let r = rooms.get(name)
  if (!r) {
    r = { name, players: new Map(), claims: new Map(), subscribers: new Set(), lastSent: 0, dirty: false, timer: null, emptySince: Date.now() }
    rooms.set(name, r)
  }
  return r
}

function snapshot(r) {
  const now = Date.now()
  const players = {}
  for (const [id, p] of r.players) {
    if (now - p.seen > STALE_MS) { r.players.delete(id); continue }
    players[id] = { name: p.name, colour: p.colour, pos: p.pos, yaw: p.yaw, found: p.found }
  }
  const claims = {}
  for (const [haul, by] of r.claims) claims[haul] = by
  return { room: r.name, t: now, players, claims }
}

function broadcast(r, force = false) {
  const now = Date.now()
  if (!force && now - r.lastSent < BROADCAST_MIN_MS) {
    // coalesce: one send after the minimum interval, however many poses arrived in it
    if (!r.timer) r.timer = setTimeout(() => { r.timer = null; broadcast(r, true) }, BROADCAST_MIN_MS - (now - r.lastSent))
    return
  }
  r.lastSent = now
  r.dirty = false
  const data = `event: state\ndata: ${JSON.stringify(snapshot(r))}\n\n`
  for (const res of r.subscribers) {
    try { res.write(data) } catch { r.subscribers.delete(res) }
  }
}

// housekeeping: drop stale players (and tell the room), forget empty rooms
setInterval(() => {
  const now = Date.now()
  for (const [name, r] of rooms) {
    let changed = false
    for (const [id, p] of r.players) if (now - p.seen > STALE_MS) { r.players.delete(id); changed = true }
    if (changed) broadcast(r, true)
    for (const res of r.subscribers) { try { res.write(`event: ping\ndata: ${now}\n\n`) } catch { r.subscribers.delete(res) } }
    if (!r.players.size && !r.subscribers.size) {
      if (!r.emptySince) r.emptySince = now
      if (now - r.emptySince > EMPTY_MS) rooms.delete(name)
    } else r.emptySince = 0
  }
}, 5_000).unref()

const clean = (s, n = 32) => String(s ?? '').replace(/[^\w .'-]/g, '').slice(0, n)
// a haul key is `kind|name|x|y` and the client compares it byte for byte, so `|` and `=` stay
const cleanKey = (s) => String(s ?? '').replace(/[^\w .'|=,-]/g, '').slice(0, 96)

/**
 * Handle `/api/rooms/...`. `seg` is the path after `rooms`; `h` carries the service's `json`,
 * `readJson` and the CORS headers so this file needs nothing of its own.
 */
export async function handle(req, res, seg, h) {
  if (!seg.length) {
    if (req.method !== 'GET') return h.json(res, 405, { error: 'GET only' })
    const list = [...rooms.values()].map((r) => ({ room: r.name, players: r.players.size, watching: r.subscribers.size }))
    return h.json(res, 200, { rooms: list })
  }
  const name = clean(seg[0], 40)
  if (!name) return h.json(res, 400, { error: 'a room needs a name' })
  const r = room(name)

  if (seg[1] === 'events' && req.method === 'GET') {
    res.writeHead(200, { ...h.cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.write(`event: state\ndata: ${JSON.stringify(snapshot(r))}\n\n`)
    r.subscribers.add(res)
    req.on('close', () => r.subscribers.delete(res))
    return true
  }
  if (seg[1] === 'pose' && req.method === 'POST') {
    const b = await h.readJson(req)
    const id = clean(b.id, 24)
    if (!id || !Array.isArray(b.pos) || b.pos.length !== 3) return h.json(res, 400, { error: 'pose needs id and pos[3]' })
    const had = r.players.get(id)
    r.players.set(id, {
      name: clean(b.name) || had?.name || 'someone',
      colour: typeof b.colour === 'number' ? b.colour & 0xffffff : had?.colour ?? 0xff9ec9,
      pos: b.pos.map((v) => +Number(v).toFixed(2)),
      yaw: +Number(b.yaw ?? 0).toFixed(3),
      found: Number(b.found ?? had?.found ?? 0) | 0,
      seen: Date.now(),
    })
    broadcast(r)
    return h.json(res, 200, { ok: true, players: r.players.size })
  }
  if (seg[1] === 'claim' && req.method === 'POST') {
    const b = await h.readJson(req)
    const id = clean(b.id, 24), haul = cleanKey(b.haul)
    if (!id || !haul) return h.json(res, 400, { error: 'claim needs id and haul' })
    const by = r.claims.get(haul)
    if (by && by !== id) return h.json(res, 200, { ok: false, by })
    r.claims.set(haul, id)
    broadcast(r, true)
    return h.json(res, 200, { ok: true, by: id })
  }
  return h.json(res, 404, { error: `no route for ${req.method} /api/rooms/${seg.join('/')}` })
}
