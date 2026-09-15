-- Build a motion-input primitive by sweeping the variables until a special actually comes out.
--
-- Every special, super and EX on every 2D board is behind a motion, and the harness could not do
-- one: a quarter circle fed at eleven frames and at twenty-eight both produced an ordinary crouching
-- normal. Rather than guess again, this tries the combinations and lets the game say which works.
--
-- Three things are being swept: **how long each direction is held**, whether a **neutral frame** is
-- inserted between steps, and whether the **button comes with the last direction or just after it**.
-- Success is unambiguous at point-blank range: Alex's Flash Chop does far more damage than the jab
-- that comes out when the motion fails, so damage alone separates them.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local HP_D = 0x2866c
local function hpd() return W:read_u32(HP_D) & 0xFFFF end

-- step = frames each direction is held; gap = neutral frames between steps; late = button after
local VARIANTS = {
  { step = 3, gap = 0, late = false },
  { step = 5, gap = 0, late = false },
  { step = 8, gap = 0, late = false },
  { step = 3, gap = 1, late = false },
  { step = 5, gap = 1, late = false },
  { step = 5, gap = 0, late = true },
  { step = 5, gap = 2, late = false },
  { step = 2, gap = 0, late = false },
}

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

local idx, state, t0, hp0 = 0, "wait", nil, nil
local function nextVariant(n)
  idx = idx + 1
  if idx > #VARIANTS then M.log("DONE"); state = "done"; return end
  state = "approach"
  M.hold(1, { "right" })
  t0 = n
end
M.at(2400, function() nextVariant(M.frame) end)

M.run(function(n)
  local v = VARIANTS[idx]
  if state == "approach" then
    if n - t0 > 70 then M.hold(1, {}); state = "settle"; t0 = n + 20 end
  elseif state == "settle" and n == t0 then
    hp0 = hpd()
    t0 = n
    state = "go"
  elseif state == "go" then
    local d = n - t0
    local unit = v.step + v.gap
    -- down, down-forward, forward — with an optional neutral frame between each.
    if d == 0 then M.hold(1, { "down" }) end
    if v.gap > 0 and d == v.step then M.hold(1, {}) end
    if d == unit then M.hold(1, { "down", "right" }) end
    if v.gap > 0 and d == unit + v.step then M.hold(1, {}) end
    if d == unit * 2 then M.hold(1, { "right" }) end
    local press = unit * 2 + (v.late and v.step or math.max(1, v.step - 1))
    if d == press then
      M.hold(1, v.late and { "jab" } or { "right", "jab" })
    end
    if d == press + 10 then M.hold(1, {}) end
    if d == 130 then
      local dmg = math.max(0, hp0 - hpd())
      M.log("step %d gap %d %-6s  damage %3d   %s", v.step, v.gap, v.late and "late" or "with",
        dmg, dmg > 25 and "*** SPECIAL CAME OUT ***" or (dmg > 0 and "just a normal" or "nothing"))
      M.hold(1, {})
      nextVariant(n)
    end
  end
end)
