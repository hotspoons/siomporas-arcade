-- What fills the super meter, and what it fills to.
--
-- The meter is at 0x286a4 in `mainram` — beside the two health bars, in what is plainly the HUD's
-- own block — and it starts a round at zero. `system.json` already carries Super Turbo's version of
-- this (`meter: { hit, block, whiffSpecial, max }`), so measuring the same four things here puts two
-- games eight years apart on one axis.
--
-- Each trial is measured from a fresh reading rather than cumulatively, and the attacks are spaced
-- far enough apart that one has finished before the next begins.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local METER, HP_D = 0x286a4, 0x2866c
local function meter() return (W:read_u32(METER) >> 16) & 0xFFFF end
local function hpd() return W:read_u32(HP_D) & 0xFFFF end

-- `far` throws the attack from out of range so it whiffs; `guard` makes the defender hold away.
local TESTS = {
  { name = "one fierce, whiffed", atk = "fierce", far = true },
  { name = "one fierce, landed", atk = "fierce" },
  { name = "one fierce, blocked", atk = "fierce", guard = true },
  { name = "one jab, landed", atk = "jab" },
  { name = "one jab, whiffed", atk = "jab", far = true },
}

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

local idx, state, t0, m0, hp0 = 0, "wait", nil, nil, nil
local function nextTest(n)
  idx = idx + 1
  if idx > #TESTS then M.log("meter ended at %d", meter()); M.log("DONE"); state = "done"; return end
  state = "approach"
  M.hold(1, TESTS[idx].far and {} or { "right" })
  M.hold(2, TESTS[idx].guard and { "right" } or {})
  t0 = n
end
M.at(2400, function() M.log("meter at the start of the round: %d", meter()); nextTest(M.frame) end)

M.run(function(n)
  if state == "approach" then
    if n - t0 > (TESTS[idx].far and 20 or 90) then
      M.hold(1, {})
      state = "settle"
      t0 = n + 18
    end
  elseif state == "settle" and n == t0 then
    m0, hp0 = meter(), hpd()
    t0 = n
    state = "go"
    M.hold(1, { TESTS[idx].atk })
  elseif state == "go" then
    local d = n - t0
    if d == 10 then M.hold(1, {}) end
    if d == 120 then
      M.log("%-22s meter %+3d   (damage %d)", TESTS[idx].name, meter() - m0, math.max(0, hp0 - hpd()))
      M.hold(1, {}); M.hold(2, {})
      nextTest(n)
    end
  end
end)
