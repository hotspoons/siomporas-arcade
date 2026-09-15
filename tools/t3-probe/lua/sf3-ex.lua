-- What an EX move costs out of the super gauge.
--
-- The gauge fills to 128 and converts to a stock. EX moves are the other thing it buys, and the
-- question is how much of it they take — which decides whether the gauge is a slow march toward one
-- big payoff or a currency you spend continuously. That is a genuine switch for a builder, and it is
-- the last piece of 3rd Strike's economy.
--
-- This needs a **motion input**, which nothing in this harness has done: a quarter-circle forward
-- is down, then down-forward, then forward, each held a couple of frames, and then the buttons. Two
-- punches together make the EX version of the move.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local METER, STOCK, HP_D = 0x286a4, 0x286a8, 0x2866c
local function gauge() return (W:read_u32(METER) >> 16) & 0xFFFF end
local function stocks() return W:read_u32(STOCK) & 0xFFFF end
local function hpd() return W:read_u32(HP_D) & 0xFFFF end

local WHICH = os.getenv("SF3_MOVE") or "ex"   -- "ex" = two punches, "special" = one

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

-- Build some gauge first, from out of range so the fighters stay put.
local FILL_FROM, FILL_TO = 2400, 3300
local state, t0, g0, hp0 = "fill", nil, nil, nil
local busyPeak = 0

M.run(function(n)
  if state == "fill" then
    if n < FILL_FROM then return end
    if n % 26 == 0 then M.hold(1, { "fierce" }) end
    if n % 26 == 10 then M.hold(1, {}) end
    if n >= FILL_TO then
      M.hold(1, {})
      state = "settle"
      t0 = n + 40
    end
  elseif state == "settle" and n == t0 then
    g0, hp0 = gauge(), hpd()
    M.log("gauge before: %d   stocks %d", g0, stocks())
    t0 = n
    state = "motion"
  elseif state == "motion" then
    local d = n - t0
    local b = W:read_u32(0x68e78) & 0xFFFF
    if b > busyPeak then busyPeak = b end
    -- Quarter-circle forward: down, down-forward, forward. Player one faces right.
    if d == 0 then M.hold(1, { "down" }) end
    if d == 14 then M.hold(1, { "down", "right" }) end
    if d == 22 then M.hold(1, { "right" }) end
    
    
    -- The direction stays held with the buttons. Releasing it to press them, which is what the
    -- first version did, turns a quarter-circle into a bare button press: the probe produced an
    -- ordinary jab and the gauge went *up* by two rather than being spent.
    if d == 28 then
      M.hold(1, WHICH == "ex" and { "right", "jab", "strong" } or { "right", "jab" })
    end
    if d == 40 then M.hold(1, {}) end
    if d == 120 then
      M.log("%-8s gauge %d -> %d  (spent %d)   stocks %d   damage dealt %d   busy peaked %d",
        WHICH, g0, gauge(), g0 - gauge(), stocks(), math.max(0, hp0 - hpd()), busyPeak)
      M.log("DONE")
      state = "done"
    end
  end
end)
