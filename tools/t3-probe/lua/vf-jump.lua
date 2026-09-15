-- The jump, frame by frame: launch speed, apex, airborne frames and gravity.
--
-- Height on this board is a float at 0x1099c in work RAM — zero on the floor, and the only thing in
-- a megabyte that rises to a peak and returns to exactly zero when the fighter lands. That makes
-- Virtua Fighter 2 the opposite of Tekken 3, where the world position has no height at all and the
-- model rises because the animation says so. Here the board is integrating a real arc, so the arc
-- has real constants, and they are the same three numbers a Street Fighter II character carries.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local W = M.WORKRAM
local Y, X = 0x1099c, 0x10f7c
local function f32(a)
  local x = (string.unpack("<f", string.pack("<I4", W:read_u32(a) & 0xFFFFFFFF)))
  if x ~= x or x == math.huge or x == -math.huge then return 0 end
  return x
end

local csv = assert(io.open(OUT .. "/vf-jump.csv", "w"))
csv:write("frame,label,y,x\n")
local label, on = "boot", false

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local base = f + 620
M.at(base - 10, function() on = true end)
M.at(base, function() label = "standing" end)
M.at(base + 40, function() label = "neutral-jump"; M.hold(1, { "up" }) end)
M.at(base + 54, function() M.hold(1, {}) end)
M.at(base + 200, function() label = "standing2" end)
-- And a forward jump, because the horizontal part is a separate constant.
M.at(base + 240, function() label = "forward-jump"; M.hold(1, { "up", "right" }) end)
M.at(base + 254, function() M.hold(1, {}) end)
M.at(base + 420, function() label = "done" end)
M.at(base + 460, function() csv:close(); on = false; M.log("DONE") end)

M.run(function(n)
  if on then csv:write(string.format("%d,%s,%.5f,%.5f\n", n, label, f32(Y), f32(X))) end
end)
