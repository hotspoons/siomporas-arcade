-- 3rd Strike's health, found the way Virtua Fighter 2's was.
--
-- CPS3 is the friendliest board in this whole exercise: `mainram` is a half-megabyte MAME share, the
-- machine runs at about 2400% of real time headless, and savestates are supported. So the search is
-- in-process, and a run costs seconds rather than minutes.
--
-- The filter is the one that has now worked twice: a word that does **nothing at all** through a
-- quiet stretch, falls when a blow lands, and then holds. Checked at 16 bits as well as 32, because
-- on Model 2 health sat beside a per-frame counter and no 32-bit word containing it ever looked
-- still. And "falls once and holds" rather than "falls twice", because a second bout of attacks that
-- misses would otherwise discard the answer.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local SIZE = W.size

local function grab()
  local t = {}
  for a = 0, SIZE - 4, 4 do t[a] = W:read_u32(a) end
  return t
end

-- Mash the way in, as on Virtua Fighter: boot times vary and coins fed during boot are ignored.
for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do
  M.tapStart(n, 1, 10)
  M.tapStart(n + 60, 2, 10)
end
for n = 1400, 2000, 110 do
  M.tap(n, 1, { "jab" }, 8)
  M.tap(n + 30, 2, { "jab" }, 8)
end

local base = 2400
local quiet, h0, h1, h1b, h2 = {}, nil, nil, nil, nil
for i, at in ipairs({ 0, 41, 93, 148, 215 }) do
  M.at(base + at, function() quiet[#quiet + 1] = grab() end)
end
M.at(base + 250, function() h0 = grab(); M.snap("before") end)
-- Walk in and jab. On this board, unlike Tekken, standing still does not guard: you block by
-- holding away, so an opponent doing nothing is an opponent being hit.
M.at(base + 270, function() M.hold(1, { "right" }) end)
M.at(base + 400, function() M.hold(1, {}) end)
for i = 0, 5 do
  M.tap(base + 430 + i * 30, 1, { "jab" }, 8)
end
M.at(base + 640, function() h1 = grab(); M.snap("after six jabs") end)
M.at(base + 700, function() h1b = grab() end)
for i = 0, 5 do
  M.tap(base + 730 + i * 30, 1, { "jab" }, 8)
end
M.at(base + 940, function()
  h2 = grab()
  M.snap("after twelve")
  for _, width in ipairs({ 32, 16 }) do
    local n = 0
    M.log("=== %d-bit ===", width)
    for a = 0, SIZE - 4, 4 do
      local function get(t, shift)
        if width == 32 then return t[a] end
        return (t[a] >> shift) & 0xFFFF
      end
      for _, shift in ipairs(width == 32 and { 0 } or { 0, 16 }) do
        local q = get(quiet[1], shift)
        local still = true
        for i = 2, #quiet do if get(quiet[i], shift) ~= q then still = false break end end
        if still and q > 8 and q < 4096 then
          local v0, v1, v1b, v2 = get(h0, shift), get(h1, shift), get(h1b, shift), get(h2, shift)
          if v0 == q and v1 < v0 and v1 == v1b and v2 <= v1 then
            n = n + 1
            if n <= 14 then
              M.log("  0x%05x%s  %d -> %d -> %d   lost %d", a,
                width == 16 and (shift == 0 and " lo" or " hi") or "", v0, v1, v2, v0 - v2)
            end
          end
        end
      end
    end
    M.log("  %d candidates", n)
  end
  M.log("DONE")
end)
M.run()
