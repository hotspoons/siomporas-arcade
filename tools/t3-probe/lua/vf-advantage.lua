-- Advantage on hit and on block: the number that decides whether a move is safe to throw.
--
-- The two fighters are the same structure **0x2000 apart**, which the very first pairing run
-- suggested and I did not believe until player two's phase counter turned up at 0x13380 against
-- player one's 0x11380. Everything else lines up on that stride: health 0x10b2c / 0x12b2c, x
-- 0x10f7c / 0x12f7c.
--
-- With both phase counters the measurement is direct. Attack, then watch which fighter gets his
-- body back first: the attacker leaves recovery on some frame, the defender leaves blockstun or
-- hitstun on another, and the difference is the advantage. Positive means the attacker is free
-- first and may act again before his opponent can — which is what "safe" means, and what every
-- decision in a fighting game is built out of.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local P1, P2 = 0x11380, 0x13380         -- phase: 0 idle, 1 startup, 2 active, 3 recovery
local HP2, GAP = 0x12b2c, 0x10f78
local function ph(a) return W:read_u32(a) end
local function hp2() return W:read_u32(HP2) & 0xFFFF end
local function gapNow()
  local x = (string.unpack("<f", string.pack("<I4", W:read_u32(GAP) & 0xFFFFFFFF)))
  if x ~= x then return 0 end
  return x
end

local TESTS = {
  { name = "P  on hit", hold = { "p" }, guard = false },
  { name = "P  blocked", hold = { "p" }, guard = true },
  { name = "K  on hit", hold = { "k" }, guard = false },
  { name = "K  blocked", hold = { "k" }, guard = true },
}

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local idx, state, t0 = 0, "wait", nil
local aFree, dFree, dBase, hp0, contact
-- A move has to *begin* before "back to idle" means anything. The first version looked for the
-- attacker's phase to read zero from frame four onwards and of course it did — the move had not
-- started yet — so every measurement was four. Same trap on the defender's side.
local aStarted, dStarted, spoiled

local function nextTest(n)
  idx = idx + 1
  if idx > #TESTS then M.log("DONE"); state = "done"; return end
  state = "approach"
  M.hold(1, { "right" })
  M.hold(2, TESTS[idx].guard and { "g" } or {})
end

M.at(f + 620, function() nextTest(M.frame) end)

M.run(function(n)
  local t = TESTS[idx]
  if state == "approach" then
    -- 2.0, not tighter: the fighters have collision pushback, so a gap of 1.3 is not a place they
    -- will stay. An earlier run closed to 1.3, waited thirty frames to settle, and by the time the
    -- punch came out they had shoved each other back out of range — every test read "no contact".
    if gapNow() < 2.0 then
      M.hold(1, {})
      state = "settle"
      t0 = n + 20
    end
  elseif state == "settle" and n == t0 then
    dBase, hp0 = ph(P2), hp2()
    M.log("  (%s: gap at the moment of attack %.2f)", TESTS[idx].name, gapNow())
    aFree, dFree, contact = nil, nil, nil
    aStarted, dStarted, spoiled = false, false, false
    t0 = n
    state = "go"
    M.hold(1, t.hold)
  elseif state == "go" then
    local d = n - t0
    if d == 12 then M.hold(1, {}) end
    -- Health going *up* means the round reset underneath us; nothing measured after that is real.
    if hp2() > hp0 then spoiled = true end
    -- Contact cannot be detected by health alone: a **blocked** hit does no damage on this board,
    -- so health never moves and every blocked test reported "no contact". The defender's phase
    -- leaving whatever it was is the signal that works for both cases.
    if not contact and (hp2() < hp0 or ph(P2) ~= dBase) then contact = d end
    -- The attacker is free when his phase has left idle and come back to it; the defender when his
    -- has left whatever it was before contact — not zero, if he is holding guard — and returned.
    if ph(P1) ~= 0 then aStarted = true end
    if aStarted and not aFree and ph(P1) == 0 then aFree = d end
    if contact and ph(P2) ~= dBase then dStarted = true end
    if spoiled then
      M.log("%-12s round reset underneath the test — retrying", t.name)
      M.hold(1, {}); M.hold(2, {})
      idx = idx - 1
      nextTest(n)
      return
    end
    if dStarted and not dFree and ph(P2) == dBase then dFree = d end
    if d >= 170 then
      local adv = (aFree and dFree) and (dFree - aFree) or nil
      M.log("%-12s contact %s   attacker free %s   defender free %s   advantage %s   damage %d%s",
        t.name,
        contact and string.format("%3d", contact) or " --",
        aFree and string.format("%3d", aFree) or " --",
        dFree and string.format("%3d", dFree) or " --",
        adv and string.format("%+3d", adv) or " --",
        math.max(0, hp0 - hp2()), "")
      M.hold(1, {}); M.hold(2, {})
      nextTest(n)
    end
  end
end)
