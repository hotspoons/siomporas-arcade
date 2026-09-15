-- Can the defender hit back? The operational test, which needs no interpretation.
--
-- The busy words give a parry a five-frame edge over a block, which is a smaller gap than this
-- mechanic's reputation suggests — and the absolute numbers they give (a blocked fierce at −38)
-- are not credible as frame advantage, because a busy word runs past the point a player can act,
-- exactly as Tekken's animation lengths do.
--
-- So ask the question that cannot be misread: after the fierce is blocked or parried, player two
-- immediately throws a jab. **Does it land, and on which frame?** A mechanic that "gives you a free
-- punish" either does or does not.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local HP_D = 0x2866c              -- the defender's health: it fell when player one attacked
local function hpd() return W:read_u32(HP_D) & 0xFFFF end
-- Player one's, found by watching which neighbour falls when player two hits back.
local CANDS = { 0x2866c - 0x498, 0x2866c + 0x498, 0x28670, 0x28668, 0x691a0, 0x691a4 }
local DEF = os.getenv("SF3_DEF") or "block"

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

local base = 2400
local state, t0, before, snapshot = "wait", nil, {}, nil
M.at(base, function() state = "approach"; M.hold(1, { "right" }); t0 = M.frame end)

M.run(function(n)
  if state == "approach" then
    if n - t0 > 110 then M.hold(1, {}); state = "settle"; t0 = n + 20 end
  elseif state == "settle" and n == t0 then
    before[HP_D] = hpd()
    for _, a in ipairs(CANDS) do before[a] = W:read_u32(a) & 0xFFFF end
    -- Guessing where the attacker's health lives got nowhere, so take the whole of RAM and diff it.
    -- Half a megabyte on this board costs nothing.
    snapshot = {}
    for a = 0, W.size - 4, 4 do snapshot[a] = W:read_u32(a) end
    t0 = n
    state = "go"
    M.hold(1, { "fierce" })
    if DEF == "block" then M.hold(2, { "right" }) end
  elseif state == "go" then
    local d = n - t0
    if d == 10 then M.hold(1, {}) end
    if DEF == "parry" and d < 40 then
      if d % 8 == 0 then M.hold(2, { "left" }) end
      if d % 8 == 3 then M.hold(2, {}) end
    end
    -- The counter: player two jabs the moment the defence resolves, and keeps jabbing.
    if d >= 24 and d < 90 then
      if d % 14 == 0 then M.hold(2, { "jab" }) end
      if d % 14 == 8 then M.hold(2, {}) end
    end
    if d == 150 then
      M.log("def=%s  defender took %d", DEF, math.max(0, before[HP_D] - hpd()))
      -- Anything that was a plausible health value and has fallen. The defender's own health is
      -- excluded, so whatever is left belongs to the man who threw the fierce.
      local found = 0
      for a = 0, W.size - 4, 4 do
        for _, shift in ipairs({ 0, 16 }) do
          local was = (snapshot[a] >> shift) & 0xFFFF
          local now = (W:read_u32(a) >> shift) & 0xFFFF
          if was >= 100 and was <= 200 and now < was and a ~= HP_D then
            found = found + 1
            if found <= 8 then
              M.log("  ATTACKER hit back? 0x%05x %s  %d -> %d  (lost %d)", a,
                shift == 0 and "lo" or "hi", was, now, was - now)
            end
          end
        end
      end
      if found == 0 then M.log("  the counter-jab never landed") end
      M.log("DONE")
      state = "done"
    end
  end
end)
