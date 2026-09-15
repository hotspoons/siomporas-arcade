-- Find 3rd Strike's phase words, so a parry can be told from a block by what it costs.
--
-- Zero damage is not what makes a parry special — a block does that too. What makes it the most
-- celebrated idea in the genre is that it carries **no blockstun**: parry an attack and you are free
-- at once, while the attacker is still finishing his swing, so the answer to a blocked attack is to
-- wait and the answer to a parried one is to hit him. Measuring that needs a word per fighter that
-- says whether he has his body back.
--
-- Same question as always: one value at rest, another for exactly as long as something is happening,
-- back to the first afterwards, and small enough to be an enumeration.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local SIZE = W.size
local function grab()
  local t = {}
  for a = 0, SIZE - 4, 4 do t[a] = W:read_u32(a) end
  return t
end

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

local base = 2400
local idle, during, after = {}, {}, nil
for i, at in ipairs({ 0, 37, 79, 124 }) do
  M.at(base + at, function() idle[#idle + 1] = grab() end)
end
-- A roundhouse thrown at nothing: long enough to sample inside, and it touches nobody.
M.at(base + 170, function() M.hold(2, { "roundhouse" }) end)
for i, at in ipairs({ 178, 186, 194, 204 }) do
  M.at(base + at, function() during[#during + 1] = grab() end)
end
M.at(base + 182, function() M.hold(2, {}) end)
M.at(base + 400, function()
  after = grab()
  local n = 0
  M.log("=== one small value at rest, another throughout a roundhouse, back again ===")
  for a = 0, SIZE - 4, 4 do
    for _, shift in ipairs({ 0, 16 }) do
      local function get(t) return (t[a] >> shift) & 0xFFFF end
      local q = get(idle[1])
      if q <= 12 then
        local still = true
        for i = 2, #idle do if get(idle[i]) ~= q then still = false break end end
        if still and get(after) == q then
          local ok, seen = true, {}
          for i = 1, #during do
            local v = get(during[i])
            if v == q or v > 12 then ok = false break end
            seen[#seen + 1] = v
          end
          if ok then
            n = n + 1
            if n <= 20 then
              M.log("  0x%05x %s  rest %d  during %s", a, shift == 0 and "lo" or "hi", q, table.concat(seen, " "))
            end
          end
        end
      end
    end
  end
  M.log("%d candidates", n)
  M.log("DONE")
end)
M.run()
