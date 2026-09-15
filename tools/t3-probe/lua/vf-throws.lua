-- Throws, and whether they are the answer to a guard that costs nothing.
--
-- Everything measured on this board so far describes a defence that is unusually cheap: guard takes
-- no chip damage at all, and a blocked jab even leaves the man who blocked it better off. The only
-- prices are that guard roots you to the floor and that it has a height — a standing one does not
-- cover your legs. If throws also go through it, the loop closes: block, and you are thrown; duck,
-- and you eat a standing attack; stand, and you eat a low.
--
-- So: the same throw, against a fighter standing idle, against one holding guard, and against one
-- crouching. Damage tells you which of those the throw beats.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local HP2, GAP, P2PH = 0x12b2c, 0x10f78, 0x13380
local function hp2() return W:read_u32(HP2) & 0xFFFF end
local function gapNow()
  local x = (string.unpack("<f", string.pack("<I4", W:read_u32(GAP) & 0xFFFFFFFF)))
  if x ~= x then return 0 end
  return x
end

-- Throws beat a standing guard outright and cannot touch a crouching one, so crouching is the
-- answer to being thrown — and something has to be the answer to crouching, or ducking would simply
-- be correct. In this genre that something is a **mid**: an attack a crouching guard does not stop.
-- None of P, K or d+K is one, so this looks for it.
local TESTS = {
  { name = "f+K   vs a crouching guard", hold = { "right", "k" }, guard = { "down", "g" } },
  { name = "df+K  vs a crouching guard", hold = { "down", "right", "k" }, guard = { "down", "g" } },
  { name = "f+P   vs a crouching guard", hold = { "right", "p" }, guard = { "down", "g" } },
  { name = "df+P  vs a crouching guard", hold = { "down", "right", "p" }, guard = { "down", "g" } },
  { name = "b+K   vs a crouching guard", hold = { "left", "k" }, guard = { "down", "g" } },
  { name = "u+K   vs a crouching guard", hold = { "up", "k" }, guard = { "down", "g" } },
}

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local idx, state, t0, hp0, gap0 = 0, "wait", nil, nil, nil
local function nextTest(n)
  idx = idx + 1
  if idx > #TESTS then M.log("DONE"); state = "done"; return end
  state = "approach"
  M.hold(1, { "right" })
  M.hold(2, TESTS[idx].guard)
end
M.at(f + 620, function() nextTest(M.frame) end)

M.run(function(n)
  local t = TESTS[idx]
  if state == "approach" then
    -- Throws want to be close. 1.4 rather than the 2.0 a punch needs.
    if gapNow() < 1.4 then
      M.hold(1, {})
      state = "settle"
      t0 = n + 25
    end
  elseif state == "settle" and n == t0 then
    hp0, gap0 = hp2(), gapNow()
    t0 = n
    state = "go"
    M.hold(1, t.hold)
  elseif state == "go" then
    local d = n - t0
    if d == 14 then M.hold(1, {}) end
    if d == 170 then
      local dmg = hp0 - hp2()
      M.log("%-32s gap %.2f   damage %2d   %s", t.name, gap0, math.max(0, dmg),
        dmg > 0 and "*** went through ***" or "nothing")
      M.hold(1, {}); M.hold(2, {})
      nextTest(n)
    end
  end
end)
