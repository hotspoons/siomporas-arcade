-- Find the word that says what the fighter is doing, which is the instrument frame data needs.
--
-- Timing recovery by "when can he walk again" is contaminated: half of these moves step forward on
-- their own, so the first movement after a punch is the punch, not the recovery ending. What is
-- needed is a word that is one value while idle, something else for exactly as long as a move lasts,
-- and back to the idle value the frame control returns.
--
-- That shape is easy to ask for: identical across several idle samples, identical again afterwards,
-- and different in the middle. It is the same stillness test that found health, pointed at a
-- different question.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local SIZE = W.size
local function grab()
  local t = {}
  for a = 0, SIZE - 4, 4 do t[a] = W:read_u32(a) end
  return t
end

local idle, during, after = {}, {}, nil

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

-- No approach at all: a move that whiffs in open space still runs its whole animation, and this is
-- a question about the attacker, not about contact.
local base = f + 620
for i, at in ipairs({ 0, 37, 79, 124, 176 }) do
  M.at(base + at, function() idle[#idle + 1] = grab() end)
end
M.at(base + 210, function() M.hold(1, { "k" }) end)   -- a kick: long enough to sample inside
for i, at in ipairs({ 216, 222, 228, 236 }) do
  M.at(base + at, function() during[#during + 1] = grab() end)
end
M.at(base + 224, function() M.hold(1, {}) end)
M.at(base + 420, function()
  after = grab()
  local n = 0
  M.log("=== idle samples %d, mid-move samples %d ===", #idle, #during)
  for a = 0, SIZE - 4, 4 do
    local q = idle[1][a]
    local still = true
    for i = 2, #idle do if idle[i][a] ~= q then still = false break end end
    if still and after[a] == q then
      local changed = true
      for i = 1, #during do if during[i][a] == q then changed = false break end end
      if changed then
        n = n + 1
        if n <= 24 then
          local s = {}
          for _, d in ipairs(during) do s[#s + 1] = string.format("%d", d[a]) end
          M.log("  0x%05x  idle %d   during %s   back to %d", a, q, table.concat(s, " "), after[a])
        end
      end
    end
  end
  M.log("%d words are one value at rest, another throughout a kick, and back again", n)
  M.log("DONE")
end)
M.run()
