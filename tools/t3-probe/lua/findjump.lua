-- Find height, and with it the fighter structure, by jumping.
--
-- A jump is the least ambiguous thing a fighter can do: one value rises, falls, and comes back to
-- exactly where it started, in about forty frames. Walking is confusable with a hundred counters and
-- a sidestep with a camera, but "changed a lot in the middle and is now bit-for-bit what it was
-- before" is a signature almost nothing in memory produces by accident. Find height and the rest of
-- the structure is next to it.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local function dump(name)
  local data = M.mem:read_range(M.LIVE_BASE, M.LIVE_BASE + M.LIVE_SIZE - 1, 8)
  local f = assert(io.open(OUT .. "/jump-" .. name .. ".bin", "wb"))
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
-- Quiet samples at irregular gaps: the mask for everything the renderer churns on its own.
-- No quiet mask this time. The idle animation never stops — she breathes, and her transform is
-- rewritten every frame — so masking "anything that moves while standing still" throws away the
-- very words being hunted. The arc has to do the work instead: six samples across the jump, which
-- must rise, peak and fall, and land back on the starting value to the bit.
M.at(base, function() M.snap("ground"); dump("g0") end)
M.at(base + 20, function() M.hold(1, { "up" }) end)
M.at(base + 34, function() M.hold(1, {}) end)
for i = 1, 6 do
  M.at(base + 32 + i * 7, function() dump("a" .. i) end)
end
-- Well after landing, and after the landing recovery has finished: back to exactly standing.
M.at(base + 60, function() M.snap("mid-jump") end)
M.at(base + 200, function() dump("g1"); M.snap("landed") end)
M.at(base + 240, function() M.log("DONE") end)
M.run()
