-- Does this board simulate height, or is a jump just an animation?
--
-- A standing jump leaves the root's y at zero for its whole 48 frames, which says the model rises
-- because the animation says so. A throw is the opposite case: the victim is lifted and slammed by
-- the game, not by his own animation, and if world y is ever simulated it has to be simulated here.
-- Both fighters' roots are known now — player one at 0x31e15c, player two at 0x31fc40, a stride of
-- 0x1ae4 — so this just walks in, throws, and watches the victim.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local P1X, P2X = 0x31e15c, 0x31fc40
local csv = assert(io.open(OUT .. "/throw.csv", "w"))
csv:write("frame,label,p1x,p1y,p1z,p2x,p2y,p2z,p1state,p1animframe\n")

local function s32(a)
  local v = M.mem:read_u32(a)
  if v >= 0x80000000 then v = v - 0x100000000 end
  return v
end
local label, on = "boot", false

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
M.at(base - 20, function() on = true end)
M.at(base, function() label = "approach"; M.hold(1, { "right" }) end)
M.at(base + 210, function() label = "in-range"; M.hold(1, {}) end)
-- A throw is left punch and left kick together, and an idle opponent does not break it.
M.at(base + 250, function() label = "throw"; M.hold(1, { "lp", "lk" }) end)
M.at(base + 262, function() label = "thrown"; M.hold(1, {}) end)
M.at(base + 500, function() label = "after" end)
for i, at in ipairs({ 255, 280, 305, 330, 360, 400 }) do
  M.at(base + at, function() M.snap("throw+" .. (at - 250)) end)
end
M.at(base + 620, function() csv:close(); on = false; M.log("DONE") end)

M.run(function(n)
  if not on then return end
  csv:write(string.format("%d,%s,%d,%d,%d,%d,%d,%d,%d,%d\n", n, label,
    s32(P1X), s32(P1X + 4), s32(P1X + 8), s32(P2X), s32(P2X + 4), s32(P2X + 8),
    s32(0x31e1a4), s32(0x31e194)))
end)
