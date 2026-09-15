-- One throw, one run, one answer.
--
-- The multi-test version of this could not answer whether a throw can be escaped, and the reason is
-- structural rather than a bug: a throw leaves its victim on the floor, so every trial after the
-- first is measuring a fighter who is getting up somewhere else. A plain control with no escape
-- input "escaped" as the fourth test of a run. So this does exactly one throw per boot — about three
-- minutes of wall clock for one number, which is the price of the answer being worth anything.
--
--   VF_ESC=none tools/t3-probe/run.sh vf-escape1.lua vf2     # control: the defender only guards
--   VF_ESC=pg   tools/t3-probe/run.sh vf-escape1.lua vf2     # the defender mashes the throw command
--   VF_ESC=p    tools/t3-probe/run.sh vf-escape1.lua vf2     # ...or just the punch half of it
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local HP2, GAP = 0x12b2c, 0x10f78
local ESC = os.getenv("VF_ESC") or "none"
local KEYS = ({ none = nil, pg = { "p", "g" }, p = { "p" }, g = { "g" } })[ESC]

local function hp2() return W:read_u32(HP2) & 0xFFFF end
local function gapNow()
  local x = (string.unpack("<f", string.pack("<I4", W:read_u32(GAP) & 0xFFFFFFFF)))
  if x ~= x then return 0 end
  return x
end

-- Mash the way in until a round is genuinely live, rather than counting frames at a boot whose
-- length varies. See M.vfEnter.
local entered = M.vfEnter(600, 7000, nil)

-- **Wait for the fight, do not count frames to it.** Boot time varies between runs — one of these
-- was still printing "sound initialize" at the frame the schedule expected a match — and the gap
-- reads 0.00 when there is no fight, so an approach that walks "until the gap is small" arrives
-- instantly and throws at nobody. Both players at full health with a real distance between them is
-- the condition that means a round is actually running.
local state, t0, hp0 = "waiting", nil, nil

M.run(function(n)
  if state == "waiting" then
    if entered(n, hp2(), gapNow()) then
      state = "approach"
      M.hold(1, { "right" })
      M.hold(2, { "g" })
    end
  elseif state == "approach" then
    if gapNow() < 1.4 then
      M.hold(1, {})
      state = "settle"
      t0 = n + 25
    end
  elseif state == "settle" and n == t0 then
    hp0 = hp2()
    t0 = n
    state = "go"
    M.hold(1, { "p", "g" })
  elseif state == "go" then
    local d = n - t0
    if d == 14 then M.hold(1, {}) end
    if KEYS and d < 80 then
      if d % 6 == 0 then M.hold(2, KEYS) end
      if d % 6 == 3 then M.hold(2, { "g" }) end
    end
    if d == 0 then M.log("  gap at the throw input: %.2f", gapNow()) end
    if d == 20 or d == 40 or d == 60 then
      M.snap("throw+" .. d)
      M.log("  f+%d  gap %.2f  p1phase %d  p2phase %d  p2hp %d", d, gapNow(),
        W:read_u32(0x11380), W:read_u32(0x13380), hp2())
    end
    if d == 180 then
      local dmg = math.max(0, hp0 - hp2())
      M.log("RESULT esc=%-4s damage %2d   %s", ESC, dmg, dmg > 0 and "thrown" or "not thrown")
      M.log("DONE")
      state = "done"
    end
  end
end)
