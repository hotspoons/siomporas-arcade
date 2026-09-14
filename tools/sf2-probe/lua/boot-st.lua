-- Boot Super Turbo into a two-player match and save a state.
--
--   PROBE_P1=ryu PROBE_P2=ryu PROBE_SECONDS=200 tools/sf2-probe/run.sh boot-st.lua ssf2tad
--
-- Champion Edition's boot.lua works to a script of frame numbers because the board is quick and
-- deterministic. Its sequel takes about forty seconds to get through its own boot, and the coin has
-- to arrive after that or it is thrown away — the first attempts at this all produced attract-mode
-- demos, which look exactly like a match until you notice you cannot move. So this one watches
-- instead of counting: it feeds coins, presses start, and taps confirm until the fighters' struct
-- comes alive at the address the hitbox viewer gives for this game, then proves the match is really
-- ours by walking player one and seeing whether they move.
--
-- Picking a particular character means moving the cursor first; PROBE_P1/PROBE_P2 do that with the
-- grid in common.lua. With neither set it takes whatever the cursor starts on, which is Ryu and Ken.
PROBE_DIR = os.getenv("PROBE_DIR") or "."
local C = dofile(PROBE_DIR .. "/common.lua")
local state_name = os.getenv("PROBE_STATE") or "st_match"
local p1, p2 = os.getenv("PROBE_P1"), os.getenv("PROBE_P2")

local n, phase, t, x0, moves = 0, "coin", 0, nil, {}

local function alive(base)
  local anim = C.mem:read_u32(base + 0x1A)
  local x = C.mem:read_i16(base + 6)
  return anim > 0x1000 and anim < 0x400000 and x > 100 and x < 1200
end

-- Cursor moves for a pick, from the grid in common.lua. Empty when no character was asked for.
local function route(player, name)
  local to = C.ST_GRID and C.ST_GRID[name]
  if not to then return end
  local from = C.ST_GRID[player == 1 and "ryu" or "ken"]
  local out = {}
  for _ = 1, math.abs(to[1] - from[1]) do out[#out + 1] = to[1] > from[1] and "right" or "left" end
  for _ = 1, math.abs(to[2] - from[2]) do out[#out + 1] = to[2] > from[2] and "down" or "up" end
  return out
end

emu.register_frame_done(function()
  n = n + 1
  if phase == "coin" then
    -- The board is still booting for the first forty seconds and anything pushed at it is lost.
    if n == 2500 or n == 2540 then C.coin(1) end
    if n == 2512 or n == 2552 then C.coin(0) end
    if n == 2700 then C.start(1, 1) end
    if n == 2712 then C.start(1, 0) end
    if n == 2800 then C.start(2, 1) end
    if n == 2812 then C.start(2, 0) end
    if n == 3000 then
      moves = { [1] = route(1, p1) or {}, [2] = route(2, p2) or {} }
      phase = "select"; t = 0
    end
    return
  elseif phase == "select" then
    t = t + 1
    -- one cursor step every 20 frames, then confirm every 40 until the fighters exist
    for pl = 1, 2 do
      local step = math.floor(t / 20) + 1
      local m = moves[pl] and moves[pl][step]
      if t % 20 == 0 and m then C.hold(pl, { m }) end
      if t % 20 == 6 and m then C.hold(pl, {}) end
    end
    if t > 200 then
      local k = t % 40
      if k == 0 then C.hold(1, { "lp" }); C.hold(2, { "lp" }) end
      if k == 6 then C.hold(1, {}); C.hold(2, {}) end
    end
    if alive(C.ADDR.p1) and alive(C.ADDR.p2) then
      C.hold(1, {}); C.hold(2, {})
      phase = "wait"; t = 0
      C.log("BOOT-ST fighters live at frame %d", n)
    end
    if t > 4000 then C.log("BOOT-ST FAILED to reach a match"); C.snapshot(); manager.machine:exit() end
    return
  elseif phase == "wait" then
    -- Let the round intro finish, then check the match answers to the stick.
    t = t + 1
    if t < 180 then return end
    if t == 180 then x0 = C.mem:read_i16(C.ADDR.p1 + 6) end
    C.hold(1, { "right" })
    if t < 220 then return end
    C.hold(1, {})
    local x1 = C.mem:read_i16(C.ADDR.p1 + 6)
    C.log("BOOT-ST walk test: x %d -> %d (%+d) %s", x0, x1, x1 - x0, (x1 ~= x0) and "CONTROLLED" or "NOT OURS")
    C.snapshot()
    if x1 ~= x0 then
      manager.machine:save(state_name)
      C.log("BOOT-ST saved %s  p1 char=%d p2 char=%d", state_name,
        C.mem:read_u8(C.ADDR.p1 + 0x291), C.mem:read_u8(C.ADDR.p2 + 0x291))
      phase = "done"; t = 0
    else
      phase = "select"; t = 0   -- an attract demo; keep pushing buttons
    end
    return
  elseif phase == "done" then
    t = t + 1
    if t > 10 then manager.machine:exit() end
  end
end)
