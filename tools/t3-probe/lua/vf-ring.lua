-- Walk off the edge of the world, and write down where it was.
--
-- The ring-out is Virtua Fighter's signature and the clearest thing separating it from every 2D
-- fighter and from Tekken's mostly-infinite floors: the stage is a platform, and leaving it loses
-- the round outright. That makes the arena a *number* — a half-width in world units — and it is
-- measurable by the crude method of holding back until the floor runs out.
--
-- Player one's x is at 0x10f7c and the gap between the fighters at 0x10f78, both IEEE floats in
-- work RAM. This records them every frame while he retreats, and photographs the moment he goes.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local W = M.WORKRAM
local P1X, GAP = 0x10f7c, 0x10f78
local function f32(a)
  local x = (string.unpack("<f", string.pack("<I4", W:read_u32(a) & 0xFFFFFFFF)))
  if x ~= x then return 0 end
  return x
end

local csv = assert(io.open(OUT .. "/vf-ring.csv", "w"))
csv:write("frame,label,p1x,gap\n")
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
M.at(base, function() on = true; label = "idle"; M.snap("start") end)
M.at(base + 60, function() label = "retreat"; M.hold(1, { "left" }) end)
-- Long enough to reach any edge: at about 0.015 units a frame, 900 frames is thirteen units.
for i = 1, 9 do
  M.at(base + 60 + i * 100, function() M.snap("retreat+" .. (i * 100)) end)
end
M.at(base + 1000, function()
  M.hold(1, {})
  label = "stopped"
end)
M.at(base + 1100, function() csv:close(); on = false; M.log("DONE") end)

M.run(function(n)
  if on then csv:write(string.format("%d,%s,%.4f,%.4f\n", n, label, f32(P1X), f32(GAP))) end
end)
