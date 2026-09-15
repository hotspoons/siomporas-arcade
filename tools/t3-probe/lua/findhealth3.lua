-- Tekken 3's health, this time bracketing a punch that is *known* to connect.
--
-- Six previous attempts searched for a number that had never moved: measured in pixels, the health
-- bars were 210 wide and unchanged in every one of them — including a run that replicated, frame for
-- frame, the one sequence that had visibly produced a **spark** on the opponent's face.
--
-- That spark was the clue and I read it as a hit. **In Tekken a character who is standing still
-- blocks automatically.** He does not need to hold anything: neutral *is* a guard against highs and
-- mids, which is not true of Street Fighter II, where standing still gets you hit, nor of Virtua
-- Fighter, where guard is a button you have to hold. So every punch thrown at an idle opponent on
-- this board was blocked, and six searches went looking for the damage it did not do.
--
-- A **low** attack is the answer: a standing guard does not cover the legs on any of these boards.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local function dump(name)
  local data = M.mem:read_range(M.LIVE_BASE, M.LIVE_BASE + M.LIVE_SIZE - 1, 8)
  local f = assert(io.open(OUT .. "/hp-" .. name .. ".bin", "wb"))
  f:write(data)
  f:close()
  M.log("DUMP %s frame %d", name, M.frame)
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
M.at(base, function() M.hold(1, { "right" }) end)
M.at(base + 200, function() M.hold(1, {}) end)
-- Quiet, in range, standing perfectly still.
for i, at in ipairs({ 210, 251, 303, 358, 425, 500 }) do
  M.at(base + at, function() dump("q" .. (i - 1)) end)
end
M.at(base + 530, function() dump("h0"); M.snap("before the punch") end)
-- The punch that works: held down, and held for long enough.
M.at(base + 560, function() M.hold(1, { "down", "rk" }) end)
M.at(base + 576, function() M.snap("punch +16") end)
M.at(base + 584, function() M.snap("punch +24") end)
M.at(base + 592, function() M.hold(1, {}) end)
M.at(base + 650, function() dump("h1"); M.snap("after the punch") end)
M.at(base + 710, function() dump("h1b") end)
-- A second one, the same way.
M.at(base + 740, function() M.hold(1, { "down", "rk" }) end)
M.at(base + 772, function() M.hold(1, {}) end)
M.at(base + 830, function() dump("h2"); M.snap("after the second") end)
M.at(base + 870, function() M.log("DONE") end)
M.run()
