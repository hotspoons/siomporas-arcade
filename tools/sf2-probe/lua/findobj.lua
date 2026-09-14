-- Where does this board keep its sprite list?
--
--   PROBE_SHARES=:objram1,:objram2 PROBE_SHOT_AT=3000 tools/sf2-probe/run.sh findobj.lua ssf2tad
--
-- Street Fighter II keeps it in gfxram at the page CPS-A register 0 points to. Its sequel moved it
-- to object RAM of its own, and another board will have put it somewhere else again. Rather than
-- read a driver, this slides a window over every candidate share and scores it: a sprite list is a
-- run of 8-byte records whose first two words land on a 384x224 screen, whose third is a non-zero
-- tile code, and which are not all the same record repeated. Whatever scores highest is worth
-- looking at, and drawing it is the proof.
local SHARES = (os.getenv("PROBE_SHARES") or ":objram1,:objram2,:gfxram"):gmatch("[^,]+")
local AT = tonumber(os.getenv("PROBE_SHOT_AT") or "2000")
local n = 0

local function score(share, base)
  local hits, codes, distinct = 0, 0, {}
  for i = 0, 63 do
    local o = base + i * 8
    if o + 8 > share.size then break end
    local x, y, code = share:read_u16(o), share:read_u16(o + 2), share:read_u16(o + 4)
    if x < 512 and y < 320 and code ~= 0 then
      hits = hits + 1
      codes = codes + 1
      distinct[code] = true
    end
  end
  local uniq = 0
  for _ in pairs(distinct) do uniq = uniq + 1 end
  return hits + uniq, hits, uniq
end

emu.register_frame_done(function()
  n = n + 1
  if n ~= AT then if n > AT + 10 then manager.machine:exit() end return end
  manager.machine.video:snapshot()
  local best = {}
  for tag in SHARES do
    local share = manager.machine.memory.shares[tag]
    if share then
      for base = 0, share.size - 512, 0x40 do
        local s, hits, uniq = score(share, base)
        if hits >= 8 then best[#best + 1] = { tag = tag, base = base, s = s, hits = hits, uniq = uniq } end
      end
    else print("no share " .. tag) end
  end
  table.sort(best, function(a, b) return a.s > b.s end)
  for i = 1, math.min(6, #best) do
    local b = best[i]
    local sh = manager.machine.memory.shares[b.tag]
    local sample = {}
    for k = 0, 3 do
      local o = b.base + k * 8
      sample[#sample + 1] = string.format("(%d,%d,%04x,%04x)", sh:read_u16(o), sh:read_u16(o + 2), sh:read_u16(o + 4), sh:read_u16(o + 6))
    end
    print(string.format("OBJ %-10s base=%05x score=%d hits=%d uniq=%d  %s", b.tag, b.base, b.s, b.hits, b.uniq, table.concat(sample, " ")))
  end
  manager.machine:exit()
end)
