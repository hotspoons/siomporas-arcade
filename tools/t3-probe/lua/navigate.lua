-- Learn the way in: coin, start, character select, fight. Snapshots at every step so the timings
-- can be read off the pictures rather than guessed.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local BOOT = tonumber(os.getenv("T3_BOOT") or "1500")   -- frames before the board is past its RAM check
local f = BOOT

M.at(BOOT - 60, function() M.snap("before coin") end)
f = M.tapCoin(f)
M.at(f + 60, function() M.snap("after coin") end)
f = M.tapStart(f + 120, 1)
M.at(f + 120, function() M.snap("after start") end)
-- Character select: whatever the cursor starts on, one punch takes it.
f = M.tap(f + 240, 1, { "lp" })
M.at(f + 60, function() M.snap("after select") end)
M.at(f + 300, function() M.snap("+5s") end)
M.at(f + 600, function() M.snap("+10s") end)
M.at(f + 900, function() M.snap("+15s") end)
M.at(f + 1200, function() M.snap("+20s") end)

M.run(function(n)
  if n % 1800 == 0 then M.log("frame %d", n) end
end)
