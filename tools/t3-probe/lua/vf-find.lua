-- Find both fighters in Virtua Fighter 2's work RAM.
--
-- This board is kinder than the PlayStation ones: Model 2 hands its megabyte of work RAM to MAME as
-- a share, and a full scan of it costs about twenty milliseconds of host time. So there is no need
-- to dump anything to disk — the whole search runs inside the emulator, one pass per sample, and
-- narrows a quarter of a million words down as it goes.
--
-- The test is the one that worked on Tekken 3: walking is a constant-speed process, so a world
-- coordinate moves by about the same amount between every pair of samples and keeps its sign. Then
-- the survivors are checked for a **zero in the next word**, which is what a fighter standing on
-- the floor looks like, and is what separates the root from the twenty bones that travel with it.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local SIZE = W.size
local WHO = tonumber(os.getenv("VF_WHO") or "1")
local DIR = os.getenv("VF_DIR") or "left"

local prev, base0, firstD, dead = {}, {}, {}, {}
local samples = 0

local function s32(v) if v >= 0x80000000 then return v - 0x100000000 end return v end

local function sample()
  samples = samples + 1
  if samples == 1 then
    for a = 0, SIZE - 4, 4 do prev[a] = s32(W:read_u32(a)); base0[a] = prev[a] end
    return
  end
  for a = 0, SIZE - 4, 4 do
    if not dead[a] then
      local v = s32(W:read_u32(a))
      local d = v - prev[a]
      if d == 0 then
        dead[a] = true
      elseif not firstD[a] then
        firstD[a] = d
      elseif (d > 0) ~= (firstD[a] > 0) or math.abs(d) > math.abs(firstD[a]) * 2
          or math.abs(d) * 2 < math.abs(firstD[a]) then
        dead[a] = true
      end
      prev[a] = v
    end
  end
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
local taking = false
M.at(base, function()
  M.snap("before walking")
  M.hold(WHO, { DIR })
  taking = true
end)
M.at(base + 200, function()
  taking = false
  M.hold(WHO, {})
  M.snap("after walking")
  local hits, roots = 0, 0
  M.log("=== player %d walked %s for %d frames, %d samples ===", WHO, DIR, 200, samples)
  for a = 0, SIZE - 4, 4 do
    if not dead[a] and firstD[a] and math.abs(firstD[a]) > 15 and math.abs(firstD[a]) < 2000 then
      hits = hits + 1
      local nxt = s32(W:read_u32(a + 4))
      if nxt == 0 and roots < 12 then
        roots = roots + 1
        M.log("  ROOT? 0x%05x  %d -> %d  (%.2f/frame)  +4=%d  +8=%d", a, base0[a], prev[a],
          (prev[a] - base0[a]) / 200, nxt, s32(W:read_u32(a + 8)))
      end
    end
  end
  M.log("%d words walked at a constant speed; %d of them had a zero next door", hits, roots)
  M.log("DONE")
end)

M.run(function(n)
  if taking and n % 20 == 0 then sample() end
end)
