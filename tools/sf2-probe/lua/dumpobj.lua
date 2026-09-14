-- One frame's sprite list, palette and screenshot, from any board that has one.
--
--   PROBE_SHARES=:objram1 PROBE_TAG=ssf2t PROBE_SHOT_AT=6000 tools/sf2-probe/run.sh dumpobj.lua ssf2tad
--
-- pose.lua is the Street Fighter II version of this and knows where that game keeps its list and
-- its fighters. This one knows nothing: it finds the list by looking for a run of 8-byte records
-- whose first two words land on the screen once the flag bits are masked off and whose third is a
-- non-zero tile code, writes what it finds, and takes MAME's own picture of the same frame so the
-- two can be compared. That comparison is the whole test of a decoder for a new board.
local OUT = os.getenv("PROBE_OUT") or "."
local TAG = os.getenv("PROBE_TAG") or "obj"
local AT = tonumber(os.getenv("PROBE_SHOT_AT") or "2000")
local MASK = tonumber(os.getenv("PROBE_XY_MASK") or "1023")
local ENTRIES = tonumber(os.getenv("PROBE_ENTRIES") or "256")
local shares = {}
for s in (os.getenv("PROBE_SHARES") or ":objram1,:objram2,:gfxram"):gmatch("[^,]+") do shares[#shares + 1] = s end

local function looksLikeList(sh, base)
  local hits, codes = 0, {}
  for i = 0, 63 do
    local o = base + i * 8
    if o + 8 > sh.size then break end
    local x, y, code = sh:read_u16(o) & MASK, sh:read_u16(o + 2) & MASK, sh:read_u16(o + 4)
    if x < 640 and y < 320 and code ~= 0 then hits = hits + 1; codes[code] = true end
  end
  local uniq = 0
  for _ in pairs(codes) do uniq = uniq + 1 end
  return hits + uniq, hits
end

local n = 0
emu.register_frame_done(function()
  n = n + 1
  if n ~= AT then if n > AT + 10 then manager.machine:exit() end return end

  local best
  for _, tag in ipairs(shares) do
    local sh = manager.machine.memory.shares[tag]
    if sh then
      for base = 0, sh.size - 512, 8 do
        local s, hits = looksLikeList(sh, base)
        if hits >= 8 and (not best or s > best.s) then best = { tag = tag, base = base, s = s, sh = sh } end
      end
    end
  end
  if not best then print("DUMPOBJ no sprite list found"); manager.machine:exit(); return end

  local list = {}
  for i = 0, ENTRIES - 1 do
    local o = best.base + i * 8
    if o + 8 > best.sh.size then break end
    local x, y, code, attr = best.sh:read_u16(o), best.sh:read_u16(o + 2), best.sh:read_u16(o + 4), best.sh:read_u16(o + 6)
    if not (x == 0 and y == 0 and code == 0) then
      list[#list + 1] = string.format('{"i":%d,"x":%d,"y":%d,"code":%d,"attr":%d}', i, x & MASK, y & MASK, code, attr)
    end
  end
  local pal = manager.machine.palettes[":palette"]
  local cols = {}
  for i = 0, pal.entries - 1 do cols[#cols + 1] = string.format("%d", pal:pen_color(i) & 0xFFFFFF) end
  local f = io.open(OUT .. "/obj-" .. TAG .. ".json", "w")
  f:write(string.format('{"game":"%s","share":"%s","base":%d,"mask":%d,"objs":[%s],"palette":[%s]}',
    emu.gamename(), best.tag, best.base, MASK, table.concat(list, ","), table.concat(cols, ",")))
  f:close()
  manager.machine.video:snapshot()
  print(string.format("DUMPOBJ %s %s base=%04x entries=%d palette=%d", TAG, best.tag, best.base, #list, pal.entries))
  manager.machine:exit()
end)
