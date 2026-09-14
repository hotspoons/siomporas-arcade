-- Dump everything needed to draw the game's sprites ourselves: the decoded graphics region, the
-- live palette, and the CPS-A/B registers.
--
--   PROBE_STATE=match_ryu_zangief tools/sf2-probe/run.sh dumpgfx.lua
--
-- MAME has already done the two things that are painful to do from the ROM zip — the ROM_LOAD64
-- interleave that stitches the twelve mask ROMs into one region, and cps1_gfx_decode(), which turns
-- the four bitplanes into packed nibbles. So `:gfx` here is 6 MB of 4bpp pixels and the only thing
-- left to work out is the pixel order inside a tile, which scripts/rom-sprites.mjs does by looking.
--
-- The palette is the hardware's, after CPS1's brightness conversion, so no colour formula is
-- needed either: entry (palette*16 + nibble) is exactly what the monitor showed. Sprites use the
-- first 512 entries (32 palettes of 16); the four scroll layers and the stars follow.
--
-- A palette is only right for the match that loaded it, so run this from a savestate of the pairing
-- whose colours you want. The graphics region is the same whatever is on screen.

local D = os.getenv("PROBE_DIR")
local P = dofile(D .. "/common.lua")
local OUT = os.getenv("PROBE_OUT") or "."
local TAG = os.getenv("PROBE_TAG") or "dump"
local STATE = os.getenv("PROBE_STATE")

local n = 0
emu.register_frame_done(function()
  n = n + 1
  if n == 2 and STATE then manager.machine:load(STATE) end
  if n ~= 60 then if n > 70 then manager.machine:exit() end return end

  local t0 = os.clock()
  local gfx = manager.machine.memory.regions[":gfx"]
  local f = io.open(OUT .. "/gfx.bin", "wb")
  local chunk, parts = {}, 0
  -- read_u32 comes back as a Lua float once the top bit is set, so it goes through math.floor
  -- before string.pack will take it.
  for o = 0, gfx.size - 4, 4 do
    parts = parts + 1
    chunk[parts] = string.pack("<I4", math.floor(gfx:read_u32(o)))
    if parts == 16384 then f:write(table.concat(chunk)); chunk = {}; parts = 0 end
  end
  if parts > 0 then f:write(table.concat(chunk, "", 1, parts)) end
  f:close()
  P.log("gfx.bin %d bytes in %.1fs", gfx.size, os.clock() - t0)

  -- The palette device holds finished RGB. Which accessor exists varies by MAME version, so try.
  local pal = manager.machine.palettes[":palette"]
  local get
  for _, fn in ipairs({ "pen_color", "entry_color", "pen" }) do
    local ok, v = pcall(function() return pal[fn](pal, 0) end)
    if ok and v then get = fn; P.log("palette accessor: %s -> %s", fn, tostring(v)); break end
  end
  local cols = {}
  for i = 0, pal.entries - 1 do
    local c = get and pal[get](pal, i) or 0
    if type(c) ~= "number" then c = (c.r << 16) | (c.g << 8) | c.b end
    cols[#cols + 1] = string.format("%d", c & 0xFFFFFF)
  end
  local pf = io.open(OUT .. "/palette-" .. TAG .. ".json", "w")
  pf:write('{"entries":' .. pal.entries .. ',"colors":[' .. table.concat(cols, ",") .. ']}')
  pf:close()

  -- The registers that say where the palette and the layers live, for reference.
  local regs = {}
  for _, share in ipairs({ "cps_a_regs", "cps_b_regs" }) do
    local s = manager.machine.memory.shares[":" .. share]
    local v = {}
    for o = 0, s.size - 2, 2 do v[#v + 1] = string.format("%d", s:read_u16(o)) end
    regs[#regs + 1] = '"' .. share .. '":[' .. table.concat(v, ",") .. ']'
  end
  local rf = io.open(OUT .. "/cpsregs-" .. TAG .. ".json", "w")
  rf:write("{" .. table.concat(regs, ",") .. "}")
  rf:close()

  -- Who is on screen, so the palette file can be matched to characters later.
  local who = {}
  for i, base in ipairs({ P.ADDR.p1, P.ADDR.p2 }) do
    who[i] = P.CHAR_NAMES[P.mem:read_u8(base + 0x291)] or "?"
  end
  P.log("palette %d entries, fighters %s vs %s", pal.entries, who[1], who[2])
  manager.machine:exit()
end)
