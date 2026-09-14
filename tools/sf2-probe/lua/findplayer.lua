-- Where does this game keep its fighters? Boots into a match, stands still, then walks, and
-- reports the words of work RAM that moved the way a position would.
--
--   PROBE_SECONDS=200 tools/sf2-probe/run.sh findplayer.lua ssf2tad
--
-- The addresses for Street Fighter II came from a hitbox viewer someone wrote in 2012. For its
-- sequel there is no such gift, so this finds them the way anyone would: a fighter's x is the
-- number that goes up by roughly the walk speed for every frame the stick is held, and its struct
-- is the bytes around it. Everything else — the animation pointer, the state byte, the health — is
-- then a short search inside that struct, which `PROBE_BASE` switches this to.
PROBE_DIR = os.getenv("PROBE_DIR") or "."
local C = dofile(PROBE_DIR .. "/common.lua")
local LO = tonumber(os.getenv("PROBE_RAM_LO") or "0xFF0000")
local HI = tonumber(os.getenv("PROBE_RAM_HI") or "0xFFFFFF")
local HOLD = os.getenv("PROBE_HOLD") or "right"
local WALK = tonumber(os.getenv("PROBE_WALK_FRAMES") or "40")
local BASE = tonumber(os.getenv("PROBE_BASE") or "0")

local n, phase, t, before = 0, "boot", 0, {}

local function snapshot()
  local s = {}
  for a = LO, HI - 2, 2 do s[a] = C.mem:read_u16(a) end
  return s
end

-- Print the struct around a base: anything that looks like a ROM pointer, and the bytes that
-- changed while the fighter was moving.
local function dumpStruct(base)
  print(string.format("STRUCT %06x", base))
  for o = 0, 0x40 - 1, 16 do
    local t2 = {}
    for k = 0, 15 do t2[#t2 + 1] = string.format("%02x", C.mem:read_u8(base + o + k)) end
    print(string.format("  +%03x %s", o, table.concat(t2, " ")))
  end
  for o = 0, 0x3FC, 4 do
    local v = C.mem:read_u32(base + o)
    if v >= 0x000100 and v < 0x400000 and (v % 2) == 0 then
      print(string.format("  +%03x u32 %08x  (ROM pointer?)", o, v))
    end
  end
end

emu.register_frame_done(function()
  n = n + 1
  -- Coins, starts, then confirm whatever the cursor is already on — repeatedly, because a select
  -- screen appears when it appears and one press at a guessed frame usually lands on nothing.
  if n == 300 or n == 340 then C.coin(1) end
  if n == 305 or n == 345 then C.coin(0) end
  if n == 600 then C.start(1, 1) end
  if n == 606 then C.start(1, 0) end
  if n == 700 then C.start(2, 1) end
  if n == 706 then C.start(2, 0) end
  if n > 900 and n < 2600 then
    local k = n % 40
    if k == 0 then C.hold(1, { "lp" }); C.hold(2, { "lp" }) end
    if k == 4 then C.hold(1, {}); C.hold(2, {}) end
  end
  if n == 2600 then C.hold(1, {}); C.hold(2, {}) end

  if phase == "boot" then
    -- Long enough for the picks, the versus screen and the round intro to be over with.
    if n < 3400 then return end
    phase = "settle"; t = 0
    C.snapshot()
    print(string.format("FINDPLAYER walking at frame %d (match flag %s)", n, tostring(C.match_active())))
    return
  elseif phase == "settle" then
    t = t + 1
    if t < 60 then return end
    before = snapshot()
    phase = "walk"; t = 0
    return
  elseif phase == "walk" then
    t = t + 1
    C.hold(1, { HOLD })
    if t < WALK then return end
    C.hold(1, {})
    local after = snapshot()
    local hits = {}
    for a, v0 in pairs(before) do
      local v1 = after[a]
      -- signed, so a fighter walking left is a fall not a wrap
      local d = v1 - v0
      if d > 32768 then d = d - 65536 elseif d < -32768 then d = d + 65536 end
      if math.abs(d) >= WALK and math.abs(d) <= WALK * 4 then hits[#hits + 1] = { a = a, v0 = v0, v1 = v1, d = d } end
    end
    table.sort(hits, function(x, y) return x.a < y.a end)
    print(string.format("FINDPLAYER %d words moved like a walk (%d frames of %s)", #hits, WALK, HOLD))
    for i = 1, math.min(24, #hits) do
      local h = hits[i]
      print(string.format("  %06x  %5d -> %5d  (%+d)", h.a, h.v0, h.v1, h.d))
    end
    C.snapshot()
    if BASE > 0 then dumpStruct(BASE) end
    manager.machine:exit()
  end
end)
