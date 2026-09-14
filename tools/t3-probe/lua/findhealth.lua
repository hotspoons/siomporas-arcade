-- Find health properly: stable for a long time, then falling when hit, then stable again.
--
-- Two earlier attempts failed in instructive ways. The first threw punches from out of range and
-- found nothing but things that count downwards. The second landed them but tested only "did it
-- fall" — and most of this RAM is scratch that changes every frame, so forty words fell by chance,
-- and every one of them turned out to oscillate wildly when watched live.
--
-- Health is not merely a falling number. It is a number that does **nothing at all** for hundreds
-- of frames, drops when a fist arrives, and then does nothing again. This takes six quiet samples
-- to establish "does nothing", which is the filter that was missing.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local function dump(name)
  local data = M.mem:read_range(M.LIVE_BASE, M.LIVE_BASE + M.LIVE_SIZE - 1, 8)
  local f = assert(io.open(OUT .. "/hp-" .. name .. ".bin", "wb"))
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
-- Six quiet samples over three hundred frames, at gaps that are not multiples of each other, so an
-- animation loop cannot make two of them agree by accident.
local quiet = { 0, 43, 97, 151, 226, 300 }
for i, at in ipairs(quiet) do
  M.at(base + at, function() dump("q" .. (i - 1)) end)
end
-- Close in. The right punch is the one proven to connect: a photograph of it shows the hit spark.
M.at(base + 330, function() M.hold(1, { "right" }) end)
M.at(base + 530, function() M.hold(1, {}) end)
M.at(base + 560, function() M.snap("in range"); dump("h0") end)
for i = 0, 5 do
  M.at(base + 580 + i * 45, function() M.hold(1, { "rp" }) end)
  M.at(base + 592 + i * 45, function() M.hold(1, {}) end)
end
M.at(base + 870, function() M.snap("after six"); dump("h1") end)
M.at(base + 930, function() dump("h1b") end)      -- still: health does not drift back
for i = 0, 5 do
  M.at(base + 960 + i * 45, function() M.hold(1, { "rp" }) end)
  M.at(base + 972 + i * 45, function() M.hold(1, {}) end)
end
M.at(base + 1250, function() M.snap("after twelve"); dump("h2") end)
M.at(base + 1290, function() M.log("DONE") end)
M.run()
