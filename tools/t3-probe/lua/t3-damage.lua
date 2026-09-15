-- Tekken 3 damage, and the mechanic that hid it for six attempts.
--
-- **Health is at 0x31e492 for player one and 0x31ff76 for player two** — one struct (0x1ae4) apart,
-- like everything else on this board, and full at **140**. It took so long to find because every
-- punch thrown at the idle opponent was *blocked*: on this board a character who is standing still
-- guards automatically against highs and mids, without holding anything. Neutral is a guard. That is
-- true of neither Street Fighter II, where standing still gets you hit, nor Virtua Fighter, where
-- guard is a button you hold and a stance you commit to.
--
-- So this measures what gets through and what does not, which is the interesting question anyway.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local P1HP, P2HP = 0x31e492, 0x31ff76
local function hp(a) return M.mem:read_u32(a) & 0xFFFF end

local MOVES = {
  { name = "rp        right punch, high", hold = { "rp" } },
  { name = "lp        left punch, high", hold = { "lp" } },
  { name = "rk        right kick", hold = { "rk" } },
  { name = "d+rk      low kick", hold = { "down", "rk" } },
  { name = "d+lk      low left kick", hold = { "down", "lk" } },
  { name = "d+rp      low punch", hold = { "down", "rp" } },
  { name = "df+rp     rising punch", hold = { "down", "right", "rp" } },
}

local f = 1440
f = M.tapCoin(f, 20)
f = M.tapCoin(f + 120, 20)
f = M.tapCoin(f + 120, 20)
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "lp" }, 6)
  M.tap(f + 170 + i * 45, 2, { "lp" }, 6)
end

local base = f + 1100
M.at(base, function() M.hold(1, { "right" }) end)
M.at(base + 200, function() M.hold(1, {}); M.log("full health: p1 %d  p2 %d", hp(P1HP), hp(P2HP)) end)

for i, mv in ipairs(MOVES) do
  local at = base + 240 + (i - 1) * 150
  local before
  M.at(at, function() before = hp(P2HP) end)
  M.at(at + 10, function() M.hold(1, mv.hold) end)
  M.at(at + 42, function() M.hold(1, {}) end)
  M.at(at + 130, function()
    local after = hp(P2HP)
    M.log("%-34s damage %2d   %s", mv.name, before - after,
      (before - after) == 0 and "blocked by simply standing there" or "got through")
  end)
end
M.at(base + 240 + #MOVES * 150 + 40, function()
  M.log("p2 health now %d of 140", hp(P2HP))
  M.log("DONE")
end)
M.run()
