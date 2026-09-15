-- Frame data for 3rd Strike: startup from the damage frame, total from the busy word.
--
-- This board makes the first number easy. An opponent standing still on CPS3 is simply **hit** —
-- defence here is a held direction, as in Champion Edition, not Tekken's free automatic guard — so
-- the frame the defender's health falls is the frame the blow arrived. At point-blank range there is
-- no travel to confuse it, so that frame is startup.
--
-- The second comes from the busy word at 0x68e78: zero when player one has his body back.
--
-- Between moves the probe walks back into range, because a hit knocks the opponent away and the next
-- attack would otherwise be thrown from further out than the last. Measuring eight moves from one
-- approach is a mistake this research has now made on three separate boards.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = manager.machine.memory.shares[":mainram"]
local HP_D, BUSY = 0x2866c, 0x68e78
local function hpd() return W:read_u32(HP_D) & 0xFFFF end
local function busy() return W:read_u32(BUSY) & 0xFFFF end

local MOVES = {
  { name = "jab", hold = { "jab" } },
  { name = "strong", hold = { "strong" } },
  { name = "fierce", hold = { "fierce" } },
  { name = "short", hold = { "short" } },
  { name = "forward", hold = { "forward" } },
  { name = "roundhouse", hold = { "roundhouse" } },
  { name = "crouching jab", hold = { "down", "jab" } },
  { name = "crouching fierce", hold = { "down", "fierce" } },
  { name = "crouching short", hold = { "down", "short" } },
  { name = "crouching roundhouse", hold = { "down", "roundhouse" } },
}

for n = 600, 4000, 120 do M.tapCoin(n, 20) end
for n = 1000, 4000, 260 do M.tapStart(n, 1, 10); M.tapStart(n + 60, 2, 10) end
for n = 1400, 2000, 110 do M.tap(n, 1, { "jab" }, 8); M.tap(n + 30, 2, { "jab" }, 8) end

local idx, state, t0, hp0 = 0, "wait", nil, nil
local started, total, contact
local function nextMove(n)
  idx = idx + 1
  if idx > #MOVES then M.log("DONE"); state = "done"; return end
  state = "approach"
  M.hold(1, { "right" })
  t0 = n
end
M.at(2400, function() nextMove(M.frame) end)

M.run(function(n)
  if state == "approach" then
    if n - t0 > 90 then M.hold(1, {}); state = "settle"; t0 = n + 18 end
  elseif state == "settle" and n == t0 then
    hp0 = hpd()
    started, total, contact = false, nil, nil
    t0 = n
    state = "go"
    M.hold(1, MOVES[idx].hold)
  elseif state == "go" then
    local d = n - t0
    if d == 10 then M.hold(1, {}) end
    if busy() ~= 0 then started = true end
    if started and not total and busy() == 0 then total = d end
    if not contact and hpd() < hp0 then contact = d end
    if d == 140 then
      M.log("%-22s startup %s   total %s   damage %3d", MOVES[idx].name,
        contact and string.format("%3d", contact) or " --",
        total and string.format("%3d", total) or " --",
        math.max(0, hp0 - hpd()))
      M.hold(1, {})
      nextMove(n)
    end
  end
end)
