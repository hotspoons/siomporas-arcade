-- Separate the two fighters in Virtua Fighter 2, without assuming anything about how they move.
--
-- The constant-speed test that cracked Tekken 3 fails here: a Virtua Fighter walk is a *stepping*
-- gait — plant, push, plant — so the distance covered between two samples varies far more than a
-- Tekken glide does, and a monotonic-with-even-increments filter throws the real coordinate away.
--
-- So this asks a weaker question that is just as decisive when you ask it twice. Move player one
-- and nobody else; anything that changed is his, or the camera's. Then move player two and nobody
-- else. What changed for exactly one of them belongs to that fighter, and the camera — which moves
-- for both — falls out of the middle.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local SIZE = W.size
local function s32(v) if v >= 0x80000000 then return v - 0x100000000 end return v end

-- **Model 2 does its geometry in floating point.** The i960 has an FPU and the TGP coprocessor is
-- float-native, so a position here is an IEEE single — 1065353216 read as an integer is 1.0f, and
-- 1142292480 is 600.0f. The PlayStation boards next door have no FPU and use fixed-point integers
-- throughout. Comparing the two as integers finds nothing and wastes an evening.
local function f32(v)
  local ok, x = pcall(function() return (string.unpack("<f", string.pack("<I4", v & 0xFFFFFFFF))) end)
  if not ok or x ~= x or x == math.huge or x == -math.huge then return nil end
  return x
end
local function grab()
  local t = {}
  for a = 0, SIZE - 4, 4 do t[a] = s32(W:read_u32(a)) end
  return t
end

local A, B, C, D
local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local base = f + 620
M.at(base, function() M.snap("rest"); A = grab() end)
M.at(base + 20, function() M.hold(1, { "left" }) end)
M.at(base + 140, function() M.hold(1, {}) end)
M.at(base + 200, function() B = grab(); M.snap("p1 moved") end)
M.at(base + 240, function() C = grab() end)
M.at(base + 260, function() M.hold(2, { "right" }) end)
M.at(base + 380, function() M.hold(2, {}) end)
M.at(base + 440, function()
  D = grab()
  M.snap("p2 moved")
  local p1, p2 = {}, {}
  for a = 0, SIZE - 4, 4 do
    local fa, fb, fc, fd = f32(A[a]), f32(B[a]), f32(C[a]), f32(D[a])
    if fa and fb and fc and fd then
      -- A coordinate on this stage is tens to low thousands of units, and a walk moves it by a
      -- visible amount. Anything astronomically large is a bit pattern that happens to parse.
      local sane = math.abs(fa) < 1e5 and math.abs(fb) < 1e5 and math.abs(fc) < 1e5 and math.abs(fd) < 1e5
      local d1, d2 = fb - fa, fd - fc
      if sane then
        if math.abs(d1) > 0.5 and d2 == 0 then p1[#p1 + 1] = a end
        if math.abs(d2) > 0.5 and d1 == 0 then p2[#p2 + 1] = a end
      end
    end
  end
  M.log("=== %d words are player one's alone, %d are player two's alone ===", #p1, #p2)
  local function show(tag, list, from, to)
    for i = 1, math.min(#list, 16) do
      local a = list[i]
      local n4, n8 = f32(to[a + 4]), f32(to[a + 8])
      M.log("  %s 0x%05x  %10.2f -> %10.2f  (%+8.2f)   +4=%s  +8=%s", tag, a, f32(from[a]), f32(to[a]),
        f32(to[a]) - f32(from[a]),
        n4 and string.format("%.2f", n4) or "-", n8 and string.format("%.2f", n8) or "-")
    end
  end
  show("P1", p1, A, B)
  M.log("  ---")
  show("P2", p2, C, D)
  -- The offset that keeps turning up between a player-one word and a player-two word is the stride.
  local tally = {}
  for _, a in ipairs(p1) do
    for _, b in ipairs(p2) do
      local g = b - a
      if g ~= 0 and math.abs(g) < 0x4000 then tally[g] = (tally[g] or 0) + 1 end
    end
  end
  local best, bestN = nil, 0
  for g, n in pairs(tally) do if n > bestN then best, bestN = g, n end end
  if best then M.log("most common gap: %+d (0x%x) seen %d times", best, math.abs(best), bestN) end
  M.log("DONE")
end)
M.run()
