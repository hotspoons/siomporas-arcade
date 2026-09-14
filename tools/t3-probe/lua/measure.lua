-- Measure the fighter: walk speed, sidestep, jump, and where the second fighter lives.
--
-- Player one's position is three consecutive words — x at 0x31e15c, then y, then z — found by
-- walking her about and watching which words followed the stick. x tracks a walk exactly; z barely
-- moves for one and then jumps seven hundred units the instant she steps off the line; y reads zero
-- on the floor. This samples all three every frame through a scripted set of moves, which is what
-- turns three addresses into numbers: units per frame, airborne frames, apex, and how far a
-- sidestep actually takes you.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local P1X = 0x31e15c
local WIN, WINLEN = 0x31c000, 0x8000   -- searched at the end for player two's mirror of x

local csv = assert(io.open(OUT .. "/measure.csv", "w"))
csv:write("frame,label,x,y,z,state,anim\n")

local label, on = "boot", false
local function phase(at, name, hold)
  M.at(at, function() label = name; M.hold(1, hold or {}) end)
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
M.at(base - 20, function() on = true end)
phase(base, "idle")
phase(base + 60, "walk-fwd", { "right" })
phase(base + 180, "idle")
phase(base + 240, "walk-back", { "left" })
phase(base + 360, "idle")
-- Sidestep: two taps of down with a gap, which the board reads as a step off the line.
phase(base + 420, "sidestep-tap", { "down" })
phase(base + 425, "idle")
phase(base + 435, "sidestep-tap", { "down" })
phase(base + 440, "sidestep")
phase(base + 560, "idle")
phase(base + 620, "jump", { "up" })
phase(base + 640, "airborne")
phase(base + 780, "idle")

-- Player two, moved on his own at the end: the window is searched for whatever followed him.
local snapWin
M.at(base + 840, function()
  snapWin = M.mem:read_range(WIN, WIN + WINLEN - 1, 8)
  label = "p2-walks"
  M.hold(2, { "right" })
end)
M.at(base + 990, function()
  M.hold(2, {})
  label = "p2-stopped"
end)
M.at(base + 1050, function()
  local now = M.mem:read_range(WIN, WIN + WINLEN - 1, 8)
  local found = {}
  for i = 0, WINLEN - 4, 4 do
    local function u32(s)
      local b1, b2, b3, b4 = s:byte(i + 1, i + 4)
      local v = b1 + b2 * 256 + b3 * 65536 + b4 * 16777216
      if v >= 0x80000000 then v = v - 0x100000000 end
      return v
    end
    local a, b = u32(snapWin), u32(now)
    local d = b - a
    if math.abs(d) > 200 and math.abs(d) < 20000 and math.abs(a) < 60000 and math.abs(b) < 60000 then
      found[#found + 1] = string.format("0x%x: %d -> %d (%+d)", WIN + i, a, b, d)
    end
  end
  M.log("=== words that followed player two (%d) ===", #found)
  for i = 1, math.min(#found, 40) do M.log("  %s", found[i]) end
  csv:close()
  M.log("DONE")
  on = false
end)

M.run(function(n)
  if not on then return end
  local function s32(a)
    local v = M.mem:read_u32(a)
    if v >= 0x80000000 then v = v - 0x100000000 end
    return v
  end
  csv:write(string.format("%d,%s,%d,%d,%d,%d,%d\n", n, label, s32(P1X), s32(P1X + 4), s32(P1X + 8),
    s32(0x31e1a4), s32(0x31e190)))
end)
