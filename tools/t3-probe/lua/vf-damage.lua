-- What one punch costs, and whether guarding one costs anything at all.
--
-- Health on this board is a **16-bit integer at 0x12b2c, full at 196** — found by landing four
-- punches and keeping the only half-words that fell by the exact proportion the health bar fell on
-- screen. A 32-bit pass never finds it: the half beside it belongs to something busy, so the
-- enclosing word never looks still.
--
-- With that, two numbers worth having. A clean hit tells you the damage scale. A *blocked* hit
-- tells you whether this game has chip damage — whether defending is free, or merely cheaper than
-- being hit. It is one of the more consequential switches a fighting-game builder could offer, and
-- it is a single comparison once you can read health.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local HP, GAP = 0x12b2c, 0x10f78
local function hp() return W:read_u32(HP) & 0xFFFF end
local function gapNow()
  local x = (string.unpack("<f", string.pack("<I4", W:read_u32(GAP) & 0xFFFFFFFF)))
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

local phase, mark, results = "wait", nil, {}
M.at(f + 620, function() phase = "approach"; M.hold(1, { "right" }) end)

M.run(function(n)
  if phase == "approach" then
    if gapNow() < 2.0 then
      M.hold(1, {})
      phase = "settle"
      mark = n + 60
      M.snap("in range")
    end
  elseif phase == "settle" and n == mark then
    results.start = hp()
    M.log("health at rest: %d", results.start)
    phase = "hit1"
    mark = n
  elseif phase == "hit1" then
    -- One punch, nobody guarding.
    if n == mark + 1 then M.hold(1, { "p" }) end
    if n == mark + 13 then M.hold(1, {}) end
    if n == mark + 90 then
      results.clean = hp()
      M.log("after one clean punch: %d  (damage %d)", results.clean, results.start - results.clean)
      phase = "guardhit"
      mark = n
      M.snap("after clean hit")
    end
  elseif phase == "guardhit" then
    -- Player two holds guard throughout; player one punches into it.
    if n == mark + 1 then M.hold(2, { "g" }) end
    if n == mark + 30 then M.hold(1, { "p" }) end
    if n == mark + 42 then M.hold(1, {}) end
    if n == mark + 130 then
      results.blocked = hp()
      M.log("after one punch into a held guard: %d  (damage %d)", results.blocked, results.clean - results.blocked)
      M.hold(2, {})
      M.snap("after blocked hit")
      phase = "second"
      mark = n
    end
  elseif phase == "second" then
    -- And a second clean punch, to check the first was not a fluke.
    if n == mark + 30 then M.hold(1, { "p" }) end
    if n == mark + 42 then M.hold(1, {}) end
    if n == mark + 130 then
      local v = hp()
      M.log("after a second clean punch: %d  (damage %d)", v, results.blocked - v)
      M.log("DONE")
      phase = "done"
    end
  end
end)
