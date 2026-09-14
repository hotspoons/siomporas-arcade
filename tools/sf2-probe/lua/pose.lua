-- One frame, looked at from every side: the screen as the hardware drew it, the sprite list that
-- drew it, the palette it used, and where the fighters were standing. This is the ground truth the
-- ROM sprite decoder in scripts/rom-sprites.mjs is checked against — render the same OBJ list from
-- gfx.bin and the two pictures have to be identical.
--
--   PROBE_STATE=match_ryu_zangief PROBE_TAG=idle tools/sf2-probe/run.sh pose.lua
--   PROBE_HOLD1=hp PROBE_WAIT=8   feed P1 a button for a few frames first
PROBE_DIR = os.getenv("PROBE_DIR") or "."
local C = dofile(PROBE_DIR .. "/common.lua")
local OUT = os.getenv("PROBE_OUT") or "."
local TAG = os.getenv("PROBE_TAG") or "pose"
local STATE = os.getenv("PROBE_STATE") or "match_ryu_zangief"
local HOLD1 = os.getenv("PROBE_HOLD1")
local WAIT = tonumber(os.getenv("PROBE_WAIT") or "0")

local GFXRAM = manager.machine.memory.shares[":gfxram"]
local n, loaded = 0, nil

-- The hardware's sprite list: 8-byte entries of x, y, code, attr in gfxram, at the page CPS-A
-- register 0 points to. CPS1 double-buffers it, so that register alternates between two halves
-- frame by frame and both hold the same sprites once a frame has settled. Blank entries are all
-- zero rather than terminated, so they are skipped rather than stopped at.
local function objects()
  local cps_a = manager.machine.memory.shares[":cps_a_regs"]
  local base = (cps_a:read_u16(0x00) * 256) % GFXRAM.size
  local list = {}
  for i = 0, 255 do
    local o = (base + i * 8) % GFXRAM.size
    local x, y, code, attr = GFXRAM:read_u16(o), GFXRAM:read_u16(o + 2), GFXRAM:read_u16(o + 4), GFXRAM:read_u16(o + 6)
    if not (x == 0 and y == 0 and code == 0) then
      list[#list + 1] = string.format('{"i":%d,"x":%d,"y":%d,"code":%d,"attr":%d}', i, x, y, code, attr)
    end
  end
  return "[" .. table.concat(list, ",") .. "]", base
end

emu.register_frame_done(function()
  n = n + 1
  if n == 2 then manager.machine:load(STATE); return end
  if n < 6 then return end
  if HOLD1 and n == 6 then C.hold(1, { HOLD1 }) end
  if HOLD1 and n == 8 then C.hold(1, {}) end
  if n < 6 + WAIT then return end

  local objs, base = objects()
  local pal = manager.machine.palettes[":palette"]
  local cols = {}
  for i = 0, pal.entries - 1 do cols[#cols + 1] = string.format("%d", pal:pen_color(i) & 0xFFFFFF) end

  local f = io.open(OUT .. "/pose-" .. TAG .. ".json", "w")
  local who = {}
  for i, b in ipairs({ C.ADDR.p1, C.ADDR.p2 }) do
    who[i] = string.format('{"char":"%s","x":%d,"y":%d,"flip":%d,"anim":%d,"state":%d}',
      C.CHAR_NAMES[C.mem:read_u8(b + 0x291)] or "?", C.mem:read_i16(b + 0x06), C.mem:read_i16(b + 0x0A),
      C.mem:read_u8(b + 0x12), C.mem:read_u32(b + 0x1A), C.mem:read_u8(b + 0x03))
  end
  f:write(string.format('{"tag":"%s","objBase":%d,"screenLeft":%d,"players":[%s,%s],"objs":%s,"palette":[%s]}',
    TAG, base, C.mem:read_i16(C.ADDR.screen_left), who[1], who[2], objs, table.concat(cols, ",")))
  f:close()
  manager.machine.video:snapshot()
  C.log("POSE %s objs=%s", TAG, #objs)
  manager.machine:exit()
end)
