-- Look for a word that distinguishes startup from active from recovery on CPS3.
--
-- The frame data measured so far is "frames from the button press to the health falling", which is
-- startup **plus** input latency plus any travel — an upper bound, and not like-for-like with the
-- Champion Edition tables, which came from that game's own frame counters. Virtua Fighter 2 had a
-- word that read 0/1/2/3 for idle/startup/active/recovery and it turned a whole move list into real
-- frame data in one run. This asks whether CPS3 has one.
--
-- Alex's fierce lands on frame 16 and the move ends at 54, so the three moments are known: sample
-- inside startup, on contact, and deep in recovery, and keep the words that differ at all three.
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

local state, t0 = "wait", nil
local rest, startup, active, recovery = nil, nil, nil, nil
M.at(2400, function() state = "approach"; M.hold(1, { "right" }); t0 = M.frame end)

M.run(function(n)
  if state == "approach" then
    if n - t0 > 90 then M.hold(1, {}); state = "settle"; t0 = n + 18 end
  elseif state == "settle" and n == t0 then
    rest = grab()
    t0 = n
    state = "go"
    M.hold(1, { "fierce" })
  elseif state == "go" then
    local d = n - t0
    if d == 10 then M.hold(1, {}) end
    if d == 8 then startup = grab() end
    if d == 17 then active = grab() end
    if d == 38 then recovery = grab() end
    if d == 120 then
      local n2 = 0
      M.log("=== words with a distinct value in each of the three phases ===")
      for a = 0, SIZE - 4, 4 do
        for _, shift in ipairs({ 0, 16 }) do
          local function g(t) return (t[a] >> shift) & 0xFFFF end
          local r, s, ac, rc = g(rest), g(startup), g(active), g(recovery)
          if r <= 20 and s <= 20 and ac <= 20 and rc <= 20
              and s ~= r and ac ~= r and rc ~= r
              and s ~= ac and ac ~= rc and s ~= rc then
            n2 = n2 + 1
            if n2 <= 16 then
              M.log("  0x%05x %s  rest %d  startup %d  active %d  recovery %d", a,
                shift == 0 and "lo" or "hi", r, s, ac, rc)
            end
          end
        end
      end
      M.log("%d candidates", n2)
      M.log("DONE")
      state = "done"
    end
  end
end)
