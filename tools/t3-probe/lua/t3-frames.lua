-- Frame data for Tekken 3, with the instruments this board actually has.
--
-- There is no 0/1/2/3 phase counter here the way Virtua Fighter 2 has one — a scan of the live half
-- of RAM turned up only binary flags — so the numbers come from three other words:
--
--   0x31e1f4   **busy**: 0 while idle, 1 for exactly as long as a move owns the fighter
--   0x31e194   frames into the current animation, resetting when the animation changes
--   0x31e492   health (player two's at +0x1ae4), which dates the frame contact happens
--
-- Total duration is measured on moves thrown into **open space**: a move's length does not depend
-- on whether it connects, and on this board an idle opponent blocks highs and mids for free anyway.
-- Startup is measured separately on the one attack known to get through a standing guard.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

-- The busy *flag* at 0x31e1f4 was found with a kick and only tracks some moves — every punch left
-- it at zero, so "the move never started" and every total came back blank. The **animation pointer**
-- is the honest signal: it changes for whatever the fighter is doing, whatever that is, and coming
-- back to the value it had while standing is the move ending.
local ANIM, ANIMF, P2HP = 0x31e190, 0x31e194, 0x31ff76
local idleAnim = nil
local function anim() return M.mem:read_u32(ANIM) end
local function busy() return (idleAnim and anim() ~= idleAnim) and 1 or 0 end
local function hp2() return M.mem:read_u32(P2HP) & 0xFFFF end

local MOVES = {
  { name = "lp     left punch", hold = { "lp" } },
  { name = "rp     right punch", hold = { "rp" } },
  { name = "lk     left kick", hold = { "lk" } },
  { name = "rk     right kick", hold = { "rk" } },
  { name = "d+lp   crouch left punch", hold = { "down", "lp" } },
  { name = "d+rk   low kick", hold = { "down", "rk" } },
  { name = "f+rp   forward right punch", hold = { "right", "rp" } },
  { name = "lp,rp  jab into cross", hold = { "lp" }, again = { "rp" }, againAt = 20 },
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
local idx, t0, started, total, contact, hp0 = 0, nil, false, nil, nil, nil
local SLOT = 200

-- Walk in first: the low kick has to reach, and the others are unaffected by the distance.
M.at(base, function() M.hold(1, { "right" }) end)
M.at(base + 200, function() M.hold(1, {}) end)

local function startMove(n)
  idx = idx + 1
  if idx > #MOVES then M.log("DONE"); return end
  t0, started, total, contact = n, false, nil, nil
  hp0 = hp2()
  idleAnim = anim()
  M.hold(1, MOVES[idx].hold)
end
-- Step back into range before each move: the low kick has to reach, and after two hundred frames of
-- other moves the fighters have drifted apart. An earlier version measured eight moves from one
-- approach and landed none of them.
local function approachThen(n)
  M.hold(1, { "right" })
  M.at(n + 70, function() M.hold(1, {}) end)
  M.at(n + 100, function() startMove(M.frame) end)
end
M.at(base + 260, function() approachThen(M.frame) end)

M.run(function(n)
  if not t0 or idx > #MOVES then return end
  local mv = MOVES[idx]
  local d = n - t0
  if d == 14 then M.hold(1, {}) end
  if mv.again and d == mv.againAt then M.hold(1, mv.again) end
  if mv.again and d == mv.againAt + 14 then M.hold(1, {}) end

  if busy() ~= 0 then started = true end
  if started and not total and busy() == 0 then total = d end
  if not contact and hp2() < hp0 then contact = d end

  if d >= SLOT - 1 then
    M.log("%-26s total %s   contact %s   damage %2d", mv.name,
      total and string.format("%3d", total) or " --",
      contact and string.format("%3d", contact) or " --",
      math.max(0, hp0 - hp2()))
    M.hold(1, {})
    t0 = nil
    approachThen(n + 20)
  end
end)
