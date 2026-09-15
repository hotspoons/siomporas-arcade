-- What each of 3rd Strike's six buttons is worth, and confirmation of where health lives.
--
-- Health is a 16-bit value at 0x2866c in `mainram`, full at **160** — which is the vitality Street
-- Fighter III gives most of its cast, and a good sign the right word was found rather than a
-- coincidence. Player two's is the copy that falls when player one attacks.
--
-- Six buttons named by strength, which is this lineage's whole idea and our own config's vocabulary:
-- jab, strong, fierce; short, forward, roundhouse.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local HP = 0x2866c
local function hp() return W:read_u32(HP) & 0xFFFF end

local MOVES = {
  { name = "jab", hold = { "jab" } },
  { name = "strong", hold = { "strong" } },
  { name = "fierce", hold = { "fierce" } },
  { name = "short", hold = { "short" } },
  { name = "forward", hold = { "forward" } },
  { name = "roundhouse", hold = { "roundhouse" } },
  { name = "crouching fierce", hold = { "down", "fierce" } },
  { name = "crouching short", hold = { "down", "short" } },
}

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

local base = 2400
local idx, state, t0, hp0 = 0, "wait", nil, nil
local function nextMove(n)
  idx = idx + 1
  if idx > #MOVES then
    M.log("full health was %d", 160)
    M.log("DONE")
    state = "done"
    return
  end
  state = "approach"
  M.hold(1, { "right" })
  t0 = n
end
M.at(base, function() M.log("health at rest: %d", hp()); nextMove(M.frame) end)

M.run(function(n)
  if state == "approach" then
    -- Walk in for a fixed spell; this board's characters start close and a normal has short reach.
    if n - t0 > 110 then
      M.hold(1, {})
      state = "settle"
      t0 = n + 20
    end
  elseif state == "settle" and n == t0 then
    hp0 = hp()
    t0 = n
    state = "go"
    M.hold(1, MOVES[idx].hold)
  elseif state == "go" then
    local d = n - t0
    if d == 10 then M.hold(1, {}) end
    if d == 90 then
      M.log("%-20s damage %3d   (health now %d)", MOVES[idx].name, math.max(0, hp0 - hp()), hp())
      M.hold(1, {})
      nextMove(n)
    end
  end
end)
