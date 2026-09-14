-- Find the fighter's world coordinates by walking her where nothing is in the way, then stepping
-- off the line.
--
-- Two mistakes are already paid for here. Walking *toward* the other fighter stops when the bodies
-- touch, so the coordinate flattens halfway through the sample and drops out of a monotonic test —
-- she now walks backwards, into open floor. And a single out-and-back is satisfied by five thousand
-- coincidences in the live half of RAM, so this takes five samples along the walk, one after she
-- stops, and two after a sidestep. That gives two independent tests: **x** moves evenly while she
-- walks and holds still when she stops; **z** does the opposite, flat through the whole walk and
-- moving only when she steps off the line. Almost nothing passes both.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local function dump(name)
  local data = M.mem:read_range(M.LIVE_BASE, M.LIVE_BASE + M.LIVE_SIZE - 1, 8)
  local f = assert(io.open(OUT .. "/walk-" .. name .. ".bin", "wb"))
  f:write(data)
  f:close()
  M.log("DUMP %-3s frame %d", name, M.frame)
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
M.at(base, function() M.snap("rest"); dump("a0") end)
-- Player one stands on the left, so "left" is away from the opponent and into open floor.
M.at(base + 20, function() M.hold(1, { "left" }) end)
M.at(base + 50, function() dump("a1") end)
M.at(base + 80, function() dump("a2") end)
M.at(base + 110, function() dump("a3") end)
M.at(base + 140, function() M.hold(1, {}); dump("a4"); M.snap("walked away") end)
M.at(base + 200, function() dump("a5") end)   -- standing still: x must stop moving
-- Sidestep, twice, the same way: two taps of down with a gap the board reads as separate taps.
M.at(base + 230, function() M.hold(1, { "down" }) end)
M.at(base + 235, function() M.hold(1, {}) end)
M.at(base + 260, function() dump("s1"); M.snap("sidestep 1") end)
M.at(base + 280, function() M.hold(1, { "down" }) end)
M.at(base + 285, function() M.hold(1, {}) end)
M.at(base + 320, function() dump("s2"); M.snap("sidestep 2") end)
M.at(base + 350, function() M.log("DONE") end)
M.run()
