-- Find the super meter: the mirror image of finding health.
--
-- Health is a number that sits still and then **falls**. A meter is a number that sits still and
-- then **rises**, and rises for doing things rather than for having things done to you. So the same
-- filter, inverted: frozen through a quiet stretch, higher after a bout of attacking, and still
-- higher after another — and small, because a meter is drawn as a handful of segments.
--
-- Worth having because `system.json` already carries a meter block from Super Turbo — gain on hit,
-- on block, on a whiffed special, and a maximum — so whatever this finds is directly comparable to
-- a game eight years its senior.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local SIZE = W.size
local function grab()
  local t = {}
  for a = 0, SIZE - 4, 4 do t[a] = W:read_u32(a) end
  return t
end

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

local base = 2400
local quiet, a0, a1, a2 = {}, nil, nil, nil
for i, at in ipairs({ 0, 41, 93, 148, 215 }) do
  M.at(base + at, function() quiet[#quiet + 1] = grab() end)
end
M.at(base + 250, function() a0 = grab() end)
-- Attack, repeatedly, into open space and then into the opponent: a meter fills for both, usually
-- by different amounts, and any word that rises for either is worth looking at.
for i = 0, 7 do
  M.tap(base + 280 + i * 26, 1, { "fierce" }, 8)
end
M.at(base + 500, function() a1 = grab() end)
M.at(base + 520, function() M.hold(1, { "right" }) end)
M.at(base + 600, function() M.hold(1, {}) end)
for i = 0, 7 do
  M.tap(base + 630 + i * 26, 1, { "fierce" }, 8)
end
M.at(base + 850, function()
  a2 = grab()
  local n = 0
  M.log("=== frozen while idle, then rising twice ===")
  for a = 0, SIZE - 4, 4 do
    for _, shift in ipairs({ 0, 16 }) do
      local function g(t) return (t[a] >> shift) & 0xFFFF end
      local q = g(quiet[1])
      local still = true
      for i = 2, #quiet do if g(quiet[i]) ~= q then still = false break end end
      if still and g(a0) == q and q < 4096 then
        local v1, v2 = g(a1), g(a2)
        if v1 > q and v2 > v1 then
          n = n + 1
          if n <= 16 then
            M.log("  0x%05x %s  %d -> %d -> %d", a, shift == 0 and "lo" or "hi", q, v1, v2)
          end
        end
      end
    end
  end
  M.log("%d candidates", n)
  M.log("DONE")
end)
M.run()
