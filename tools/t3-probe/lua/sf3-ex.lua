-- What an EX move costs out of the super gauge — asked of Ryu, who has a quarter-circle special.
--
-- The first attempt at this asked Alex, whose Flash Chop never came out however the motion was fed,
-- and the harness was blamed. It was not the harness: the same primitive makes Ryu throw a fireball
-- across the screen on the first attempt. **A character who does not have the move you are asking
-- for looks exactly like a broken input.**
--
-- Ryu is player two here, on the right, so his forward is `left`. One punch gives the special; two
-- give the EX version, and the difference between the gauge before and after is the answer.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
-- Found by watching what rose while only player two attacked, **not** by assuming the health
-- stride: the two health bars are 0x18 apart but the gauges are 0x34, and guessing cost a run.
local P2_METER = 0x286d8
local HP_P1 = 0x28654
local function gauge() return (W:read_u32(P2_METER) >> 16) & 0xFFFF end
local function hp1() return W:read_u32(HP_P1) & 0xFFFF end

local WHICH = os.getenv("SF3_MOVE") or "ex"

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

-- **Build a real gauge first.** Eighteen units out of a hundred and twenty-eight is not enough to
-- buy an EX, and a game that cannot afford one simply gives you the ordinary special — which looks
-- exactly like a failed input and cost two runs to see through.
--
-- Fireballs are a poor way to fill it, at about one unit each. Blocked fierces are worth nine, so
-- player two walks in and player one holds away and blocks fifteen of them: no damage to anybody,
-- no knockdown, and a gauge near full in three hundred frames.
M.at(2450, function() M.hold(2, { "left" }) end)              -- player two walks in
M.at(2530, function() M.hold(2, {}) end)
M.at(2540, function() M.hold(1, { "left" }) end)              -- player one holds away: blocking
for i = 0, 14 do
  M.at(2560 + i * 26, function() M.hold(2, { "left", "fierce" }) end)
  M.at(2570 + i * 26, function() M.hold(2, { "left" }) end)
end
M.at(2960, function() M.hold(2, {}) end)
local g0, hp0
M.at(3000, function()
  g0, hp0 = gauge(), hp1()
  M.log("gauge before: %d", g0)
end)
M.qcf(3030, 2, "left", WHICH == "ex" and { "jab", "strong" } or { "fierce" })
M.at(3230, function()
  M.log("%-8s gauge %d -> %d  (spent %d)   damage to player one %d",
    WHICH, g0, gauge(), g0 - gauge(), math.max(0, hp0 - hp1()))
  M.log("DONE")
end)
M.run()
