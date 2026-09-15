-- Find the way into a two-player 3rd Strike match, with pictures.
--
-- CPS3 runs at about 2400% of real time headless — twenty-four times faster than the 3D boards — so
-- calibration here is cheap enough to do by brute force: mash coins, both start buttons and a
-- confirming punch for a long while, and photograph every three hundred frames.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

for n = 600, 6000, 120 do M.tapCoin(n, 20) end
for n = 1000, 6000, 260 do
  M.tapStart(n, 1, 10)
  M.tapStart(n + 60, 2, 10)
end
-- Jab confirms a character on this board.
for n = 1400, 6000, 110 do
  M.tap(n, 1, { "jab" }, 8)
  M.tap(n + 30, 2, { "jab" }, 8)
end
for i = 0, 22 do
  M.at(1500 + i * 300, function() M.snap("t" .. (1500 + i * 300)) end)
end
M.run()
