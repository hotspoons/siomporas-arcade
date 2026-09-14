-- Boot sf2ce into a two-player VS match and save a state named match_<p1>_<p2>.
-- Usage (see ../run.sh):  PROBE_P1=ryu PROBE_P2=zangief mame sf2ceea ... -autoboot_script boot.lua
-- Timings are frame counts from power-on; the emulation is deterministic so they are stable.
PROBE_DIR = os.getenv("PROBE_DIR") or "."
local C = dofile(PROBE_DIR .. "/common.lua")
local p1 = C.CHARS[os.getenv("PROBE_P1") or "ryu"]
local p2 = C.CHARS[os.getenv("PROBE_P2") or "zangief"]
local state_name = os.getenv("PROBE_STATE") or string.format("match_%s_%s", C.CHAR_NAMES[p1], C.CHAR_NAMES[p2])
local n, fight_at, saved = 0, nil, false

-- cursor plan: list of {frame, player, dir}
local plan = {}
local function route(p, from, to, t0)
  local c, r = from[1], from[2]
  local t = t0
  while c ~= to[1] do
    local d = (to[1] > c) and "right" or "left"
    plan[#plan+1] = {t, p, d}; c = c + ((d == "right") and 1 or -1); t = t + 20
  end
  while r ~= to[2] do
    local d = (to[2] > r) and "down" or "up"
    plan[#plan+1] = {t, p, d}; r = r + ((d == "down") and 1 or -1); t = t + 20
  end
  return t
end
route(1, {0,0}, C.GRID[p1], 1300)
route(2, {0,1}, C.GRID[p2], 1300)

emu.register_frame_done(function()
  n = n + 1
  if n == 400 or n == 420 then C.coin(1) end
  if n == 405 or n == 425 then C.coin(0) end
  if n == 1150 then C.start(1, 1) end
  if n == 1155 then C.start(1, 0) end
  if n == 1250 then C.start(2, 1) end
  if n == 1255 then C.start(2, 0) end
  for _, m in ipairs(plan) do
    if n == m[1] then C.hold(m[2], {m[3]}) end
    if n == m[1] + 5 then C.hold(m[2], {}) end
  end
  if n == 1480 then C.snapshot("select") end
  if n == 1500 then C.hold(1, {"lp"}); C.hold(2, {"lp"}) end
  if n == 1505 then C.hold(1, {}); C.hold(2, {}) end
  if n > 1505 and not fight_at and (C.mem:read_u16(C.ADDR.match_flags) & 0x0A) == 0x0A then fight_at = n end
  if fight_at and n == fight_at + 2 and not saved then
    saved = true
    C.log("BOOT sel=%02x/%02x fight_at=%d saving %s", C.mem:read_u8(C.ADDR.p1_select), C.mem:read_u8(C.ADDR.p2_select), fight_at, state_name)
    C.snapshot("match")
    manager.machine:save(state_name)
  end
  if saved and n == fight_at + 12 then manager.machine:exit() end
  if n > 4000 then C.log("BOOT FAILED"); C.snapshot("fail"); manager.machine:exit() end
end)
