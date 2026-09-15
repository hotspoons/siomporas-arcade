-- The parry: the most celebrated idea in the genre, and the thing no other board here can express.
--
-- Street Fighter II and Virtua Fighter both answer "how do I not get hit" with a held input — a
-- direction, or a button. Third Strike answers it with **timing**: tap *toward* the attack as it
-- arrives and it does nothing at all, no damage and no blockstun, and you are free immediately.
--
-- Player one stands on the left, so player one's forward is right and **player two's forward is
-- left**. Blocking is the opposite — away — which on this board means player two holds right. The
-- three cases below are therefore: do nothing, hold away, and tap toward.
--
--   SF3_DEF=none   the defender does nothing
--   SF3_DEF=block  the defender holds away
--   SF3_DEF=parry  the defender taps toward the attack, repeatedly, across the whole strike
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local HP = 0x2866c
local function hp() return W:read_u32(HP) & 0xFFFF end
local DEF = os.getenv("SF3_DEF") or "none"

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

local base = 2400
local state, t0, hp0 = "wait", nil, nil
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
    t0 = n
    state = "go"
    M.hold(1, { "fierce" })
    if DEF == "block" then M.hold(2, { "right" }) end
  elseif state == "go" then
    local d = n - t0
    if d == 10 then M.hold(1, {}) end
    -- Tapping, not holding: a parry is an edge, and holding toward would just be walking forward.
    if DEF == "parry" and d < 60 then
      if d % 8 == 0 then M.hold(2, { "left" }) end
      if d % 8 == 3 then M.hold(2, {}) end
    end
    if d == 110 then
      local dmg = math.max(0, hp0 - hp())
      M.log("RESULT def=%-5s  fierce did %3d damage   %s", DEF, dmg,
        dmg == 0 and "*** nothing got through ***" or "hit")
      M.log("DONE")
      state = "done"
    end
  end
end)
