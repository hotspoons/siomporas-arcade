-- Pin down player two's structure by making him walk and looking for a word that walks like one.
--
-- Player one's x is known, and a walk there is 14.4 units every frame, forever, in a straight line.
-- Player two's x must do the same thing, so this samples a window every ten frames while only he
-- moves and keeps the words whose increments are all the same sign and all about the same size.
-- Limbs swing and fail that test; a root does not. Doing the arithmetic inside Lua avoids dumping
-- four megabytes twenty times to answer a question about two kilobytes.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local LO = tonumber(os.getenv("T3_LO") or "0x310000")
local HI = tonumber(os.getenv("T3_HI") or "0x330000")
local ROOTONLY = os.getenv("T3_ROOTONLY") == "1"
local samples = {}

local function s32(a)
  local v = M.mem:read_u32(a)
  if v >= 0x80000000 then v = v - 0x100000000 end
  return v
end

local f = 1440
f = M.tapCoin(f, 20)
f = M.tapCoin(f + 120, 20)
f = M.tapCoin(f + 120, 20)
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "lp" }, 6)
  M.tap(f + 170 + i * 45, 2, { "lp" }, 6)
end

local base = f + 1100
local taking = false
M.at(base, function() M.hold(2, { "right" }); taking = true end)
M.at(base + 200, function()
  M.hold(2, {})
  taking = false
  M.log("=== words that walked like a fighter (%d samples) ===", #samples)
  local n = 0
  for a = LO, HI - 4, 4 do
    -- Skip the first and last few samples: a walk ramps up and stops, and those frames are not
    -- the constant-speed stretch the test is about.
    local lo_i, hi_i = 3, #samples - 1
    local first = samples[lo_i][a]
    local deltas, ok = {}, true
    for i = lo_i + 1, hi_i do
      local d = samples[i][a] - samples[i - 1][a]
      if d == 0 then ok = false break end
      deltas[#deltas + 1] = d
    end
    if ok then
      local lo, hi, sign = math.huge, 0, deltas[1] > 0
      for _, d in ipairs(deltas) do
        if (d > 0) ~= sign then ok = false break end
        local m = math.abs(d)
        if m < lo then lo = m end
        if m > hi then hi = m end
      end
      -- Constant speed: the biggest step no more than half again the smallest.
      if ok and hi <= lo * 2.0 and lo > 20 and hi < 600 and n < 40 and (not ROOTONLY or s32(a + 4) == 0) then
        n = n + 1
        local span = (hi_i - lo_i) * 20
        -- Player one's layout is x, then a y that reads zero on the floor, then z. A candidate
        -- whose next word is zero is the root; the rest are the bones that travel with it.
        local y, z = s32(a + 4), s32(a + 8)
        M.log("  0x%x  %d -> %d  (%.1f/frame)   +4=%d  +8=%d%s", a, first,
          samples[hi_i][a], (samples[hi_i][a] - first) / span, y, z,
          y == 0 and "   <-- looks like the root" or "")
      end
    end
  end
  M.log("DONE")
end)

M.run(function(nf)
  if taking and nf % 20 == 0 then
    local s = {}
    for a = LO, HI - 4, 4 do s[a] = s32(a) end
    samples[#samples + 1] = s
  end
end)
