-- Find the real timings: two credits, two players, both characters chosen, and then a picture every
-- 150 frames so the frame the round actually starts on can be read off rather than guessed.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local f = 1440
f = M.tapCoin(f, 20)
f = M.tapCoin(f + 120, 20)
f = M.tapCoin(f + 120, 20)
M.at(f + 60, function() M.snap("credits in") end)
f = M.tapStart(f + 120, 2, 10)
M.at(f + 120, function() M.snap("after 2P start") end)
-- Take whoever the cursor is on, from both sides, and keep pressing in case one press is eaten.
for i = 0, 5 do
  M.tap(f + 180 + i * 40, 1, { "lp" }, 6)
  M.tap(f + 200 + i * 40, 2, { "lp" }, 6)
end
local base = f + 420
for i = 0, 16 do
  M.at(base + i * 150, function() M.snap("t+" .. (i * 150)) end)
end
M.run()
