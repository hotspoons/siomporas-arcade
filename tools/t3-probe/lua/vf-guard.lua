-- What the defender's phase counter actually says, frame by frame, while he guards and is hit.
--
-- The block-advantage measurement produced one number it had no business producing — a jab that is
-- −10 on block — and the fault was assuming the defender sits at a clean idle value while holding
-- guard. He does not, so "returned to what it was before contact" fired on a flicker rather than on
-- the end of blockstun. Before trusting any blocked number, the vocabulary has to be read: what the
-- counter says standing, what it says guarding, what it says in blockstun, and what in hitstun.
--
-- Traced with its neighbours, because a stun *timer* — a number counting down to zero — would be a
-- better instrument than a phase, and boards of this era usually have one.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local P2PH, P1PH = 0x13380, 0x11380
local HP2, GAP = 0x12b2c, 0x10f78
local WATCH = { 0x13380, 0x13384, 0x13388, 0x1338c, 0x13390, 0x13184, 0x1318c, 0x12b2c }
local function u32(a) return W:read_u32(a) end
local function hp2() return u32(HP2) & 0xFFFF end
local function gapNow()
  local x = (string.unpack("<f", string.pack("<I4", u32(GAP) & 0xFFFFFFFF)))
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

local state, t0, guarding = "wait", nil, false
M.at(f + 620, function() state = "approach"; M.hold(1, { "right" }) end)

local function row(tag, d)
  local s = {}
  for _, a in ipairs(WATCH) do s[#s + 1] = string.format("%d", u32(a)) end
  M.log("%-10s f%+4d  %s", tag, d, table.concat(s, " "))
end

M.run(function(n)
  if state == "approach" then
    if gapNow() < 2.0 then
      M.hold(1, {})
      state = "settle"
      t0 = n + 20
    end
  elseif state == "settle" and n == t0 then
    M.log("watching: %s", "13380 13384 13388 1338c 13390 13184 1318c 12b2c(hp)")
    row("standing", 0)
    M.hold(2, { "g" })
    guarding = true
    state = "guarding"
    t0 = n
  elseif state == "guarding" then
    local d = n - t0
    if d == 1 or d == 5 or d == 20 then row("guarding", d) end
    if d == 40 then
      M.hold(1, { "p" })
      state = "blocked"
      t0 = n
    end
  elseif state == "blocked" then
    local d = n - t0
    if d == 12 then M.hold(1, {}) end
    if d <= 40 and d % 4 == 0 then row("blocked", d) end
    if d == 120 then
      M.hold(2, {})
      state = "regap"
      M.hold(1, { "right" })
    end
  elseif state == "regap" then
    if gapNow() < 2.0 then
      M.hold(1, {})
      state = "settle2"
      t0 = n + 20
    end
  elseif state == "settle2" and n == t0 then
    -- Same punch, nobody guarding, so the two can be compared frame for frame.
    M.hold(1, { "p" })
    state = "hit"
    t0 = n
  elseif state == "hit" then
    local d = n - t0
    if d == 12 then M.hold(1, {}) end
    if d <= 80 and (d < 20 or d % 4 == 0) then row("hit", d) end
    if d == 120 then M.log("DONE"); state = "done" end
  end
end)
