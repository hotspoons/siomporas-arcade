-- Separate the two fighters, and with them the shape of a fighter.
--
-- Move player one and nothing else; then move player two and nothing else. A word that follows the
-- first and ignores the second belongs to player one, and vice versa. The two sets then have a
-- common offset between them — the stride from one fighter's structure to the other's — and the
-- moment that stride is known, every field found on one fighter is a field on the other. That is
-- worth more than any single address: it is the struct.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local function dump(name)
  local data = M.mem:read_range(M.LIVE_BASE, M.LIVE_BASE + M.LIVE_SIZE - 1, 8)
  local f = assert(io.open(OUT .. "/pair-" .. name .. ".bin", "wb"))
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
-- Two quiet samples first, sixty frames apart with nobody touching anything. Whatever differs
-- between these two is the renderer talking to itself — display lists, vertex and colour buffers,
-- rebuilt every frame whether or not the fight has moved — and it is most of the live half of RAM.
-- Masking it out is what turns thousands of coincidences into a handful of fields.
-- Irregular gaps on purpose: the idle animation loops, and two samples a round number of frames
-- apart can land on the same pose and mask nothing at all.
M.at(base - 180, function() dump("q0") end)
M.at(base - 97, function() dump("q1") end)
M.at(base - 31, function() dump("q2") end)
M.at(base, function() M.snap("rest"); dump("a0") end)
-- Player one backs away; player two is not touched at all.
M.at(base + 20, function() M.hold(1, { "left" }) end)
M.at(base + 140, function() M.hold(1, {}) end)
M.at(base + 200, function() dump("a1"); M.snap("p1 moved") end)
M.at(base + 240, function() dump("a2") end)        -- both standing: the settling baseline
-- Now player two backs away, on his own side of the screen, and player one is not touched.
M.at(base + 260, function() M.hold(2, { "right" }) end)
M.at(base + 380, function() M.hold(2, {}) end)
M.at(base + 440, function() dump("a3"); M.snap("p2 moved") end)
M.at(base + 480, function() dump("a4") end)
M.at(base + 510, function() M.log("DONE") end)
M.run()
