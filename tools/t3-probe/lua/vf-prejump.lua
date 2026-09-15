-- Is the delay before leaving the ground the game's pre-jump, or just how long I held the button?
--
-- The first jump measurement held "up" for fourteen frames and the fighter left the ground on the
-- fourteenth, which is exactly the sort of coincidence that becomes a wrong number in a table if
-- nobody checks it. So: jump four times with the stick held for 4, 8, 14 and 30 frames, and see
-- whether the delay follows the hold or stays put. If it stays put it is the board's pre-jump
-- startup and belongs in the character data; if it tracks the hold, it was mine all along.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local Y = 0x1099c
local function f32(a)
  local x = (string.unpack("<f", string.pack("<I4", W:read_u32(a) & 0xFFFFFFFF)))
  if x ~= x then return 0 end
  return x
end

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local HOLDS = { 4, 8, 14, 30 }
local base = f + 620
local pressedAt, holdLen, watching, left = nil, nil, false, false

for i, len in ipairs(HOLDS) do
  local at = base + (i - 1) * 260
  M.at(at, function()
    M.hold(1, { "up" })
    pressedAt, holdLen, watching, left = M.frame, len, true, false
  end)
  M.at(at + len, function() M.hold(1, {}) end)
  M.at(at + 240, function()
    if not left then M.log("hold %2d frames: never left the ground", holdLen) end
    watching = false
  end)
end
M.at(base + 4 * 260 + 40, function() M.log("DONE") end)

M.run(function(n)
  if watching and not left and f32(Y) ~= 0 then
    left = true
    M.log("hold %2d frames: airborne on frame %d after the press%s",
      holdLen, n - pressedAt, (n - pressedAt) == holdLen and "   <-- equals the hold" or "")
  end
end)
