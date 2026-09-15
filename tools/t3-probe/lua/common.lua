-- Shared plumbing for the Namco System 12 probes (Tekken 3 and its Soul Calibur / Tekken Tag
-- siblings). The 2D harness next door cannot be reused as-is: this board has no sprite list, no
-- savestates, and its main RAM is not a MAME "share" — it belongs to the R3000 and is reached
-- through the CPU's own address space.
--
-- The one structural consequence of no savestates: everything a plan wants to measure has to happen
-- in a single run, in order, from a cold boot. So this file is a schedule — a queue of steps, each
-- with a frame to fire on — rather than a library of things a probe can do whenever it likes.

local M = {}

M.cpu = manager.machine.devices[":maincpu"]
M.mem = M.cpu.spaces["program"]
M.ports = manager.machine.ioport.ports

--- Model 2 hands its work RAM to MAME as a share, which the PSX boards do not. Where it exists it
--- is a megabyte rather than four, and it is the only place the fight can be.
M.WORKRAM = manager.machine.memory.shares[":workram"]

-- Main RAM: **4MB**, not the 2MB a PlayStation has — Namco doubled it for System 12, and the whole
-- of the live game state sits in the half above 0x200000. The lower half is code and static data
-- and changes about thirteen bytes a second, which is how much time you can lose believing the
-- board is a stock PSX. It is mirrored again at 0x400000, so read the first 4MB and no more.
M.RAM_BASE = 0x00000000
M.RAM_SIZE = 0x00400000
--- The half worth diffing: everything that moves, moves in here.
M.LIVE_BASE = 0x00200000
M.LIVE_SIZE = 0x00200000

local function findField(...)
  for _, name in ipairs({ ... }) do
    for tag, port in pairs(M.ports) do
      if port.fields[name] then return { tag, name } end
    end
  end
end

-- The two schools of 3D fighting differ before you measure anything, and it shows up here.
--
-- **Tekken** gives you four buttons and they are *limbs* — left punch, right punch, left kick,
-- right kick — and no guard button at all: you block by holding away, as every 2D game does.
-- **Virtua Fighter** gives you three, and one of them is **Guard**. Blocking is a button you press,
-- not a direction you hold, which frees the stick for movement while defending and is most of why
-- the two games feel nothing alike.
--
-- Both sets are looked up here and whichever the board has is what you get; the other is nil and
-- `M.hold` ignores it.
M.FIELD = { {}, {} }
for p = 1, 2 do
  local pre = "P" .. p .. " "
  M.FIELD[p] = {
    up = findField(pre .. "Up"), down = findField(pre .. "Down"),
    left = findField(pre .. "Left"), right = findField(pre .. "Right"),
    -- Tekken: four limbs
    lp = findField(pre .. "Button 1"), rp = findField(pre .. "Button 2"),
    lk = findField(pre .. "Button 3"), rk = findField(pre .. "Button 4"),
    -- Virtua Fighter: punch, kick, and a guard you hold
    p = findField(pre .. "Punch"), k = findField(pre .. "Kick"), g = findField(pre .. "Guard"),
    -- Street Fighter III on CPS3: six buttons named by strength, which is our own config's
    -- vocabulary — the 2D lineage names attacks by how hard they are, the 3D boards by which limb.
    jab = findField(pre .. "Jab Punch"), strong = findField(pre .. "Strong Punch"),
    fierce = findField(pre .. "Fierce Punch"), short = findField(pre .. "Short Kick"),
    forward = findField(pre .. "Forward Kick"), roundhouse = findField(pre .. "Roundhouse Kick"),
    start = findField(p .. " Player Start", p .. " Players Start"),
  }
end

--- True on a board whose defence is a button rather than a direction.
M.HAS_GUARD = M.FIELD[1].g ~= nil
M.COIN = findField("Coin 1", "Coin A", "Coin")

function M.set(port, name, v)
  local f = M.ports[port] and M.ports[port].fields[name]
  if f then f:set_value(v) end
end

local function press(f, v) if f then M.set(f[1], f[2], v) end end
function M.coin(v) press(M.COIN, v) end
function M.start(p, v) press(M.FIELD[p].start, v) end

--- Hold exactly this set of directions and buttons for player `p`; everything else released.
function M.hold(p, names)
  local want = {}
  for _, n in ipairs(names or {}) do want[n] = true end
  for k, f in pairs(M.FIELD[p]) do
    if k ~= "start" then press(f, want[k] and 1 or 0) end
  end
end

function M.release_all()
  for p = 1, 2 do M.hold(p, {}); M.start(p, 0) end
  M.coin(0)
end

-- --- the schedule -------------------------------------------------------------------------------

M.frame = 0
local queue = {}

--- Run `fn` once, `delay` frames from now (or from `after`, when chaining).
function M.at(frame, fn) queue[#queue + 1] = { frame = frame, fn = fn } end

--- Hold `names` for player `p` from `frame` for `len` frames. Returns the frame it ends on.
function M.tap(frame, p, names, len)
  len = len or 4
  M.at(frame, function() M.hold(p, names) end)
  M.at(frame + len, function() M.hold(p, {}) end)
  return frame + len
end

function M.tapStart(frame, p, len)
  len = len or 6
  M.at(frame, function() M.start(p, 1) end)
  M.at(frame + len, function() M.start(p, 0) end)
  return frame + len
end

function M.tapCoin(frame, len)
  len = len or 8
  M.at(frame, function() M.coin(1) end)
  M.at(frame + len, function() M.coin(0) end)
  return frame + len
end

--- Install the frame hook. `each` runs every frame after the queue, if given.
function M.run(each)
  emu.register_frame_done(function()
    M.frame = M.frame + 1
    for _, step in ipairs(queue) do
      if step.frame == M.frame then step.fn() end
    end
    if each then each(M.frame) end
  end)
end

--- Get a Virtua Fighter board into a two-player match, without assuming how long it takes to boot.
---
--- Fixed schedules are what several wasted runs were made of. Boot time varies — one run was still
--- printing "sound initialize" at the frame a schedule expected a live match — and coins fed during
--- boot are simply ignored, after which the probe measures the **attract-mode demo**: two CPUs
--- fighting, health falling on its own, and every number meaningless.
---
--- So this keeps feeding coins, pressing both start buttons and confirming the character selection,
--- over and over, for as long as it takes. `ready(fn)` is called once, on the frame a real round is
--- detected — both fighters at full health with a real distance between them.
function M.vfEnter(from, until_, ready)
  local fired = false
  for n = from, until_, 100 do
    M.tapCoin(n, 20)
  end
  for n = from + 400, until_, 220 do
    M.tapStart(n, 1, 10)
    M.tapStart(n + 40, 2, 10)
  end
  -- The selection mashing has to **stop**. Left running it carries on into the match, where it is
  -- two fighters punching each other every ninety frames — so health never reads full, the "is a
  -- round live" test never fires, and the run does nothing at all for two hundred seconds.
  local selectUntil = math.min(until_, from + 3000)
  for n = from + 600, selectUntil, 90 do
    M.tap(n, 1, { "p" }, 6)
    M.tap(n + 25, 2, { "p" }, 6)
  end
  return function(n, hp, gap)
    if fired then return true end
    -- Nearly full, not exactly full: a stray selection press may have landed a jab before the probe
    -- looked, and waiting for a pristine 196 then waits forever.
    if hp > 150 and gap > 0.5 and n > selectUntil then
      fired = true
      M.log("round is live at frame %d (gap %.2f)", n, gap)
      if ready then ready(n) end
    end
    return fired
  end
end

function M.snap(tag)
  manager.machine.video:snapshot()
  if tag then print(string.format("SNAP f%d %s", M.frame, tag)) end
end

function M.log(fmt, ...) print(string.format(fmt, ...)) end

return M
