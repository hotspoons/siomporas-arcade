-- The numbers that define the Virtua Fighter school of fighting, measured off the board.
--
-- Player one's x sits at 0x10f7c in work RAM as an IEEE float and the gap between the fighters at
-- 0x10f78; the words either side are sampled too, because one of them should be height and the
-- board has not yet been asked. The sequence walks forward and back, guards, guards *while* holding
-- a direction — the question that matters on a board where defence is a button rather than a
-- direction — crouches, and jumps.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local W = M.WORKRAM
local LO, N = 0x10f70, 8
local function f32(a)
  local x = (string.unpack("<f", string.pack("<I4", W:read_u32(a) & 0xFFFFFFFF)))
  if x ~= x or x == math.huge or x == -math.huge then return 0 end
  return x
end

local csv = assert(io.open(OUT .. "/vf-measure.csv", "w"))
local head = { "frame", "label" }
for i = 0, N - 1 do head[#head + 1] = string.format("w%x", LO + i * 4) end
csv:write(table.concat(head, ",") .. "\n")

local label, on = "boot", false
local function phase(at, name, hold)
  M.at(at, function() label = name; M.hold(1, hold or {}); M.log("f%d %s", M.frame, name) end)
end

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local base = f + 620
M.at(base - 20, function() on = true end)
phase(base, "idle")
phase(base + 90, "walk-fwd", { "right" })
phase(base + 210, "idle2")
phase(base + 270, "walk-back", { "left" })
phase(base + 390, "idle3")
-- Guard is a button here. Holding it alone, and then holding it *with* a direction, is the whole
-- difference from a board where you block by holding away.
phase(base + 450, "guard", { "g" })
phase(base + 540, "guard-fwd", { "g", "right" })
phase(base + 660, "guard-back", { "g", "left" })
phase(base + 780, "idle4")
phase(base + 840, "crouch", { "down" })
phase(base + 930, "idle5")
phase(base + 990, "jump", { "up" })
phase(base + 1010, "airborne")
phase(base + 1130, "idle6")
M.at(base + 1200, function() csv:close(); on = false; M.log("DONE") end)
M.at(base + 1030, function() M.snap("mid-jump") end)
M.at(base + 480, function() M.snap("guarding") end)

M.run(function(n)
  if not on then return end
  local row = { n, label }
  for i = 0, N - 1 do row[#row + 1] = string.format("%.4f", f32(LO + i * 4)) end
  csv:write(table.concat(row, ",") .. "\n")
end)
