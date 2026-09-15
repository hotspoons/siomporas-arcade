-- Frame data for Virtua Fighter 2, off the board.
--
-- `0x11380` is a phase counter for player one: **0 idle, 1 startup, 2 active, 3 recovery**, and back
-- to 0 the frame control returns. That is the whole of frame data in one word, and it is measured
-- here on moves thrown into **open space** — no opponent in range at all.
--
-- Whiffing on purpose is the point. Measuring against a body means the opponent is knocked back
-- after every hit, so each move is thrown from a different distance than the last, and half of them
-- miss; an earlier version of this file produced four dashes and two wrong numbers for exactly that
-- reason. A move's startup, active and recovery do not depend on whether it hits. Damage does, and
-- that is measured separately by `vf-damage.lua`, which walks into range for one punch at a time.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local PHASE = 0x11380
local function phase() return W:read_u32(PHASE) end

local MOVES = {
  { name = "P      standing punch", hold = { "p" } },
  { name = "K      standing kick", hold = { "k" } },
  { name = "P,P    punch twice", hold = { "p" }, again = { "p" }, againAt = 16 },
  { name = "d+P    crouching punch", hold = { "down", "p" } },
  { name = "d+K    crouching kick", hold = { "down", "k" } },
  { name = "f+P    forward punch", hold = { "right", "p" } },
  { name = "f+K    forward kick", hold = { "right", "k" } },
  { name = "b+P    back punch", hold = { "left", "p" } },
  { name = "u+K    jumping kick", hold = { "up", "k" } },
  { name = "P+K    punch and kick", hold = { "p", "k" } },
  { name = "P+G    punch with guard (throw)", hold = { "p", "g" } },
}

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local idx, t0, counts, watching = 0, nil, nil, false
local SLOT = 200

local function startMove(n)
  idx = idx + 1
  if idx > #MOVES then
    M.log("DONE")
    return
  end
  t0 = n
  counts = { [0] = 0, 0, 0, 0 }
  watching = true
  M.hold(1, MOVES[idx].hold)
end

M.at(f + 620, function() startMove(M.frame) end)

M.run(function(n)
  if not watching then return end
  local mv = MOVES[idx]
  local d = n - t0
  if d == 12 then M.hold(1, {}) end
  if mv.again and d == mv.againAt then M.hold(1, mv.again) end
  if mv.again and d == mv.againAt + 12 then M.hold(1, {}) end

  local p = phase()
  if p >= 0 and p <= 3 then counts[p] = counts[p] + 1 end

  if d >= SLOT - 1 then
    watching = false
    M.hold(1, {})
    M.log("%-30s startup %3d   active %3d   recovery %3d   total %3d",
      mv.name, counts[1], counts[2], counts[3], counts[1] + counts[2] + counts[3])
    startMove(n + 20)
  end
end)
