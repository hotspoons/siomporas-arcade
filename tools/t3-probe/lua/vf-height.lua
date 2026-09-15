-- Settle the height question on Model 2 properly, rather than by looking at eight words.
--
-- Both 3D boards so far look as though a jump's height lives in the animation rather than in the
-- fighter's world position — on Tekken 3 the root's y stayed zero through a jump *and* a throw,
-- after searching the whole of RAM. On Virtua Fighter 2 only the eight words around x were checked,
-- which is a hint and not a search. This is the search: the whole megabyte of work RAM, read as
-- floats, across a standing sample, six samples spanning the jump, and a sample after landing.
--
-- Height has to be a float that is identical standing and after landing, different in every
-- airborne sample, and shaped like an arc — rising to a single peak and coming back. Work RAM is a
-- share here and a full pass costs about twenty milliseconds, so this is affordable in a way it
-- never was on the PlayStation boards.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local SIZE = W.size
local function f32(v)
  local x = (string.unpack("<f", string.pack("<I4", v & 0xFFFFFFFF)))
  if x ~= x or x == math.huge or x == -math.huge then return nil end
  return x
end
local function grab()
  local t = {}
  for a = 0, SIZE - 4, 4 do t[a] = W:read_u32(a) end
  return t
end

local rest, air, landed = nil, {}, nil

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local base = f + 620
M.at(base, function() rest = grab(); M.snap("standing") end)
M.at(base + 20, function() M.hold(1, { "up" }) end)
M.at(base + 34, function() M.hold(1, {}) end)
for i = 1, 6 do
  M.at(base + 30 + i * 9, function() air[#air + 1] = grab() end)
end
M.at(base + 55, function() M.snap("mid-air") end)
M.at(base + 220, function()
  landed = grab()
  M.snap("landed")
  local n = 0
  M.log("=== %d airborne samples ===", #air)
  for a = 0, SIZE - 4, 4 do
    if rest[a] == landed[a] then
      local r = f32(rest[a])
      if r and math.abs(r) < 1e5 then
        local vs, ok = {}, true
        for i = 1, #air do
          local x = f32(air[i][a])
          if not x or math.abs(x) > 1e5 or x == r then ok = false break end
          vs[i] = x
        end
        if ok then
          -- An arc: away from the standing value, to a single peak, and back.
          local away = {}
          for i, v in ipairs(vs) do away[i] = math.abs(v - r) end
          local peak, pv = 1, away[1]
          for i, v in ipairs(away) do if v > pv then peak, pv = i, v end end
          if peak > 1 and peak < #away and pv > 0.05 then
            for i = 2, peak do if away[i] < away[i - 1] then ok = false end end
            for i = peak + 1, #away do if away[i] > away[i - 1] then ok = false end end
            if ok and n < 20 then
              n = n + 1
              local s = {}
              for _, v in ipairs(vs) do s[#s + 1] = string.format("%.3f", v) end
              M.log("  0x%05x  standing %.3f  air %s  peak %+.3f", a, r, table.concat(s, " "), pv)
            end
          end
        end
      end
    end
  end
  M.log("%d words arced while airborne and came back to their standing value", n)
  M.log("DONE")
end)
M.run()
