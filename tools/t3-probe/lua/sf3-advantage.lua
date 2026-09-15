-- What a parry costs the attacker, against what a block costs him.
--
-- Both stop the damage. The difference is who gets to move next, and it is the whole reason the
-- parry is the most admired mechanic in the genre: block an attack and you wait out your blockstun
-- while the attacker recovers alongside you, but **parry it and you are free at once**, with the
-- attacker still finishing a swing he can no longer do anything about.
--
-- The two fighters are the same structure **0x498** apart on this board. Busy reads 0 when a fighter
-- has his body back and non-zero while something owns him: player one at 0x68e78, player two at
-- 0x69310.
--
--   SF3_DEF=none | block | parry
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local P1BUSY, P2BUSY = 0x68e78, 0x68e78 + 0x498
local HP = 0x2866c
local function busy(a) return W:read_u32(a) & 0xFFFF end
local function hp() return W:read_u32(HP) & 0xFFFF end
local DEF = os.getenv("SF3_DEF") or "none"
local ATK = os.getenv("SF3_ATK") or "fierce"

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

local base = 2400
local state, t0, hp0 = "wait", nil, nil
local aStarted, dStarted, aFree, dFree, contact
M.at(base, function() state = "approach"; M.hold(1, { "right" }); t0 = M.frame end)

M.run(function(n)
  if state == "approach" then
    if n - t0 > 110 then
      M.hold(1, {})
      state = "settle"
      t0 = n + 20
    end
  elseif state == "settle" and n == t0 then
    hp0 = hp()
    aStarted, dStarted, aFree, dFree, contact = false, false, nil, nil, nil
    t0 = n
    state = "go"
    M.hold(1, { ATK })
    if DEF == "block" then M.hold(2, { "right" }) end
  elseif state == "go" then
    local d = n - t0
    if d == 10 then M.hold(1, {}) end
    if DEF == "parry" and d < 60 then
      if d % 8 == 0 then M.hold(2, { "left" }) end
      if d % 8 == 3 then M.hold(2, {}) end
    end
    if busy(P1BUSY) ~= 0 then aStarted = true end
    if aStarted and not aFree and busy(P1BUSY) == 0 then aFree = d end
    if busy(P2BUSY) ~= 0 then dStarted = true end
    if dStarted and not dFree and busy(P2BUSY) == 0 then dFree = d end
    if not contact and hp() < hp0 then contact = d end
    if d == 150 then
      local adv = (aFree and dFree) and (dFree - aFree) or nil
      M.log("def=%-5s atk=%-10s damage %3d   attacker free %s   defender free %s   advantage %s",
        DEF, ATK, math.max(0, hp0 - hp()),
        aFree and string.format("%3d", aFree) or " --",
        dFree and string.format("%3d", dFree) or " --",
        adv and string.format("%+4d", adv) or "  --")
      M.log("DONE")
      state = "done"
    end
  end
end)
