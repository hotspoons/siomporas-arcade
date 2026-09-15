-- Find a Virtua Fighter's world position: a float that moves while he walks and stops dead when he
-- does.
--
-- Three things had to be right at once, and each was learned the hard way. **Floats**, because
-- Model 2's geometry is IEEE single and reading it as integers finds only nonsense. **A loose
-- tolerance**, because a Virtua Fighter walk is a stepping gait and the distance between samples
-- genuinely varies. And **the stop**, which is the filter that does the real work: the board is full
-- of buffers that move while the fight moves, and almost none of them freeze the instant the stick
-- is released.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local SIZE = W.size
local WHO = tonumber(os.getenv("VF_WHO") or "1")
local DIR = os.getenv("VF_DIR") or "left"

local function f32(v)
  local x = (string.unpack("<f", string.pack("<I4", v & 0xFFFFFFFF)))
  if x ~= x or x == math.huge or x == -math.huge then return nil end
  return x
end
local function grab()
  local t = {}
  for a = 0, SIZE - 4, 4 do t[a] = W:read_u32(a) end
  return t
end

local walking, stopped = {}, {}
local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local base = f + 620
M.at(base, function() M.snap("rest"); walking[#walking + 1] = grab(); M.hold(WHO, { DIR }) end)
for i = 1, 6 do
  M.at(base + i * 22, function() walking[#walking + 1] = grab() end)
end
M.at(base + 145, function() M.hold(WHO, {}) end)
-- Well after the stop, so the last step has finished settling.
for i = 1, 3 do
  M.at(base + 200 + i * 25, function() stopped[#stopped + 1] = grab() end)
end
M.at(base + 300, function()
  M.snap("after")
  local n = 0
  M.log("=== walked %s for 145 frames: %d samples, %d after stopping ===", DIR, #walking, #stopped)
  for a = 0, SIZE - 4, 4 do
    -- Frozen after the stop, to the bit.
    local s1 = stopped[1][a]
    if s1 == stopped[2][a] and s1 == stopped[3][a] then
      local vs, ok = {}, true
      for i = 1, #walking do
        local x = f32(walking[i][a])
        if not x or math.abs(x) > 1e5 then ok = false break end
        vs[i] = x
      end
      if ok then
        local d0 = vs[2] - vs[1]
        if math.abs(d0) > 0.2 then
          local lo, hi = math.huge, 0
          for i = 2, #vs do
            local d = vs[i] - vs[i - 1]
            if (d > 0) ~= (d0 > 0) or d == 0 then ok = false break end
            lo = math.min(lo, math.abs(d)); hi = math.max(hi, math.abs(d))
          end
          -- A stepping gait, so three to one is a fair spread for a real coordinate.
          if ok and hi <= lo * 3 and n < 20 then
            n = n + 1
            local fin = f32(s1)
            M.log("  0x%05x  %9.2f -> %9.2f  (%+.2f over 145f, %.2f/frame)  settled %9.2f  +4=%s  +8=%s",
              a, vs[1], vs[#vs], vs[#vs] - vs[1], (vs[#vs] - vs[1]) / 145, fin,
              tostring(f32(stopped[1][a + 4])), tostring(f32(stopped[1][a + 8])))
          end
        end
      end
    end
  end
  M.log("%d candidates", n)
  M.log("DONE")
end)
M.run()
