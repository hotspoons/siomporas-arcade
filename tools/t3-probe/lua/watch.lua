-- Watch a window of the fighter structure through a scripted sequence of moves.
--
-- Dump-diffing found the structure; it is a poor way to read it. This walks, sidesteps, jumps,
-- crouches and throws a punch with the frame and the input written next to every sample, so one run
-- produces a table in which x, y, z, facing, state and health can be told apart by what they do.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local P1 = tonumber(os.getenv("T3_P1") or "0x31e100")
local STRIDE = tonumber(os.getenv("T3_STRIDE") or "0x1ae4")
local WORDS = tonumber(os.getenv("T3_WORDS") or "48")

local csv = assert(io.open(OUT .. "/watch.csv", "w"))
local head = { "frame", "label" }
for i = 0, WORDS - 1 do head[#head + 1] = string.format("p1_%x", P1 + i * 4) end
for i = 0, WORDS - 1 do head[#head + 1] = string.format("p2_%x", P1 + STRIDE + i * 4) end
csv:write(table.concat(head, ",") .. "\n")

local label = "boot"
local sampling = false
local function sample()
  local row = { M.frame, label }
  for _, b in ipairs({ P1, P1 + STRIDE }) do
    for i = 0, WORDS - 1 do
      local v = M.mem:read_u32(b + i * 4)
      if v >= 0x80000000 then v = v - 0x100000000 end
      row[#row + 1] = v
    end
  end
  csv:write(table.concat(row, ",") .. "\n")
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
local function phase(at, name, hold)
  M.at(at, function()
    label = name
    M.hold(1, hold or {})
    M.log("f%d  %s", M.frame, name)
  end)
end
M.at(base - 30, function() sampling = true end)
phase(base, "idle")
phase(base + 90, "walk-back", { "left" })
phase(base + 210, "idle2")
phase(base + 270, "sidestep-tap", { "down" })
phase(base + 275, "sidestep", {})
phase(base + 285, "sidestep-tap2", { "down" })
phase(base + 290, "sidestep2", {})
phase(base + 360, "jump", { "up" })
phase(base + 375, "airborne", {})
phase(base + 480, "crouch", { "down" })
phase(base + 540, "idle3", {})
phase(base + 570, "punch", { "lp" })
phase(base + 578, "after-punch", {})
phase(base + 660, "kick", { "rk" })
phase(base + 668, "after-kick", {})
M.at(base + 780, function()
  csv:close()
  M.log("DONE — wrote watch.csv")
end)
M.at(base + 300, function() M.snap("after sidesteps") end)
M.at(base + 400, function() M.snap("airborne") end)
M.at(base + 600, function() M.snap("punching") end)

M.run(function(n)
  if sampling and n % 3 == 0 and n <= base + 780 then sample() end
end)
