-- Throw escapes: the thing that has to exist, on a board where a throw is worth a fifth of a life.
--
-- The measured shape of this game is a guard that costs nothing and a throw worth 40 of 196 that
-- goes straight through it. That is only a game if the throw can be answered, and in this series the
-- answer is to input the throw command yourself as it lands. So: the same throw, against a defender
-- who does nothing, one who guards, one who holds the escape the whole time, and one who taps it at
-- the moment of contact — with the contact frame measured in the first trial rather than assumed.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local HP2, GAP = 0x12b2c, 0x10f78
local function hp2() return W:read_u32(HP2) & 0xFFFF end
local function gapNow()
  local x = (string.unpack("<f", string.pack("<I4", W:read_u32(GAP) & 0xFFFFFFFF)))
  if x ~= x then return 0 end
  return x
end

-- `at` is when player two's escape attempt goes in, relative to the throw input. nil means never;
-- "hold" means from before the throw and never released.
-- Holding a button is not the same as pressing it: a game that reads an *edge* sees a held button
-- once, at the start, and never again. Tapping at three chosen offsets found nothing either, but
-- three guesses out of forty frames is not a search. Mashing covers every frame in one trial.
-- Mashing P, G or P+G all avoided the throw, while *holding* G did not. Before calling that a throw
-- escape, the control that decides it: mash a **direction**, which is not an escape command in any
-- version of this game. If that avoids the throw too, then nothing is being escaped — the defender
-- is simply moving, and the throw is whiffing.
-- Directions and K do not avoid the throw; P and P+G do. One result needs repeating before it can
-- be believed: G on its own appeared to escape once, which would be strange, since G is the half of
-- the command that is *not* the punch. Each candidate is therefore run twice here.
-- P alone and G alone were each thrown twice on a repeat, so the single run in which they appeared
-- to escape was noise. **P+G together** is the only candidate that has escaped more than once, and
-- it is also the throw command itself, which is what the escape is supposed to be. Three of it
-- against two controls, because one trial of anything on this board has now proved worthless twice.
local TESTS = {
  { name = "guarding (control 1)", esc = nil },
  { name = "mashing P+G, 1st", esc = "mash", keys = { "p", "g" } },
  { name = "mashing P+G, 2nd", esc = "mash", keys = { "p", "g" } },
  { name = "guarding (control 2)", esc = nil },
  { name = "mashing P+G, 3rd", esc = "mash", keys = { "p", "g" } },
}

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local idx, state, t0, hp0, contactFrame = 0, "wait", nil, nil, nil
local function nextTest(n)
  idx = idx + 1
  if idx > #TESTS then M.log("DONE"); state = "done"; return end
  state = "approach"
  M.hold(1, { "right" })
  M.hold(2, { "g" })
end
M.at(f + 620, function() nextTest(M.frame) end)

M.run(function(n)
  local t = TESTS[idx]
  if state == "approach" then
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
    -- Mash the escape: pressed for three frames of every six, from the throw input until well past
    -- the moment of contact, so no timing window inside that span can be missed.
    if t.esc == "mash" and d < 80 then
      if d % 6 == 0 then M.hold(2, t.keys) end
      if d % 6 == 3 then M.hold(2, {}) end
    end
    if not contactFrame and hp2() < hp0 then contactFrame = d end
    if d == 180 then
      local dmg = math.max(0, hp0 - hp2())
      M.log("%-30s damage %2d   %s", t.name, dmg,
        dmg == 0 and "*** escaped ***" or (idx == 1 and ("thrown — contact on frame " .. tostring(contactFrame)) or "thrown"))
      M.hold(1, {}); M.hold(2, {})
      nextTest(n)
    end
  end
end)
