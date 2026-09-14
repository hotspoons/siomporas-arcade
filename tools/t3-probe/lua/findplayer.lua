-- Find the fighters in 2MB of PSX RAM by moving one of them and watching what follows.
--
-- Versus, not arcade mode: press BOTH start buttons on the same credits and the second player is a
-- person who does nothing at all. That stillness is the whole method — with a CPU opponent, half of
-- RAM is moving and nothing can be attributed. Player one then walks one way, walks back past where
-- he began, and steps off the line; a world coordinate is a word that follows.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local function dump(name)
  local data = M.mem:read_range(M.LIVE_BASE, M.LIVE_BASE + M.LIVE_SIZE - 1, 8)
  local f = assert(io.open(OUT .. "/ram-" .. name .. ".bin", "wb"))
  f:write(data)
  f:close()
  M.log("DUMP %-6s frame %d", name, M.frame)
end

local f = 1440
f = M.tapCoin(f, 20)
f = M.tapCoin(f + 120, 20)
f = M.tapCoin(f + 120, 20)
-- Both start buttons: player one starts the game, player two joins it. Pressing only the second
-- one starts a game *as* player two against the machine, which looks almost identical and is not
-- what we want.
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
M.at(f + 90, function() M.snap("both in") end)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "lp" }, 6)
  M.tap(f + 170 + i * 45, 2, { "lp" }, 6)
end
M.at(f + 600, function() M.snap("round intro") end)

-- Control begins roughly 750 frames after the start press; give it another 300 to be sure.
local base = f + 1100
M.at(base, function() M.snap("at rest"); dump("rest") end)
M.at(base + 30, function() M.hold(1, { "right" }) end)
M.at(base + 150, function() M.hold(1, {}) end)
M.at(base + 160, function() M.snap("walked right"); dump("right") end)
M.at(base + 190, function() M.hold(1, { "left" }) end)
M.at(base + 430, function() M.hold(1, {}) end)
M.at(base + 440, function() M.snap("walked left"); dump("left") end)
-- Sidestep: two taps of down, which on this board steps off the line rather than crouching.
M.at(base + 470, function() M.hold(1, { "down" }) end)
M.at(base + 474, function() M.hold(1, {}) end)
M.at(base + 482, function() M.hold(1, { "down" }) end)
M.at(base + 486, function() M.hold(1, {}) end)
M.at(base + 540, function() M.snap("sidestepped"); dump("side") end)
M.at(base + 570, function() M.log("DONE") end)

M.run()
