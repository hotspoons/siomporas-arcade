-- Look for Tekken 3's phase word: the equivalent of Virtua Fighter 2's 0x11380.
--
-- On that board one word reads 0 idle, 1 startup, 2 active, 3 recovery, and returns to 0 the frame
-- control comes back — and nine moves' worth of frame data fell out of a single run once it was
-- found. Tekken has an animation pointer and a frames-into-the-animation counter but nothing yet
-- that names the *phase*, so this asks the same question the same way: which words are one value
-- while standing, something else for exactly as long as a kick lasts, and back again afterwards.
--
-- Thrown into open space on purpose. A move's phases do not depend on whether it connects, and on
-- this board an idle opponent blocks everything anyway.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local function dump(name)
  local data = M.mem:read_range(M.LIVE_BASE, M.LIVE_BASE + M.LIVE_SIZE - 1, 8)
  local f = assert(io.open(OUT .. "/st-" .. name .. ".bin", "wb"))
  f:write(data)
  f:close()
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
for i, at in ipairs({ 0, 37, 79, 124 }) do
  M.at(base + at, function() dump("q" .. (i - 1)) end)
end
M.at(base + 170, function() M.hold(1, { "rk" }) end)
for i, at in ipairs({ 178, 186, 196, 208 }) do
  M.at(base + at, function() dump("d" .. (i - 1)) end)
end
M.at(base + 190, function() M.hold(1, {}) end)
M.at(base + 400, function() dump("after"); M.log("DONE") end)
M.run()
