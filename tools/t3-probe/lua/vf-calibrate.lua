-- Learn the way into a two-player Virtua Fighter 2 match, with a picture every 150 frames.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

-- This board is set to **two coins per credit** — the attract screen says CREDIT 0/2 — so three
-- coins buys one play and the second player never gets in. Six would do; eight is cheap insurance.
local f = tonumber(os.getenv("VF_BOOT") or "900")
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
M.at(f + 60, function() M.snap("credits") end)
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
M.at(f + 90, function() M.snap("both started") end)
-- Take whoever the cursor is on, from both sides, several times over.
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end
local base = f + 450
for i = 0, 14 do
  M.at(base + i * 150, function() M.snap("t+" .. (i * 150)) end)
end
M.run()
