-- Two open questions in one run: where player two's structure is, and whether height is simulated.
--
-- Height is not in the fighter structure as a walking fighter uses it — 0x31e160 reads zero through
-- an entire jump while the state word plainly says airborne. The hypothesis is that a jump's height
-- is animation-driven, the model's root rising because the animation says so, and that world y only
-- comes alive when a body is **launched**. A juggle is the test, and a juggle needs the opponent's
-- structure, so this finds that first: player two walks alone, and whatever follows him smoothly is
-- his root.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

local P1X = 0x31e15c
local P2X = tonumber(os.getenv("T3_P2X") or "0x31fdf0")
local BAR = 0x25fe5c          -- the health bar's widest quad: it shrinks when damage lands
local ANIM = 0x31e190         -- player one's animation pointer
local FRAMEC = 0x31e194       -- frames into that animation
local STATE = 0x31e1a4

local csv = assert(io.open(OUT .. "/juggle.csv", "w"))
csv:write("frame,label,p1x,p1y,p1z,p2x,p2y,p2z,bar,anim,animframe,state\n")

local label, on = "boot", false
local function s32(a)
  local v = M.mem:read_u32(a)
  if v >= 0x80000000 then v = v - 0x100000000 end
  return v
end
local function phase(at, name, hold, who)
  M.at(at, function() label = name; M.hold(who or 1, hold or {}) end)
end

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
M.at(base - 20, function() on = true end)
-- 1. Player two walks on his own, so his root can be told from his swinging limbs.
phase(base, "idle")
phase(base + 60, "p2-walks", { "right" }, 2)
phase(base + 200, "p2-idle", {}, 2)
-- 2. Player one closes in and throws a launcher: down-forward held, then the right punch.
phase(base + 260, "p1-approach", { "right" })
phase(base + 450, "idle2")
M.at(base + 500, function() label = "df-held"; M.hold(1, { "down", "right" }) end)
M.at(base + 510, function() label = "launcher"; M.hold(1, { "down", "right", "rp" }) end)
M.at(base + 522, function() label = "after-launcher"; M.hold(1, {}) end)
M.at(base + 620, function() label = "settling" end)
-- 3. And a plain right punch, for a clean startup-to-contact measurement on a standing man.
M.at(base + 700, function() label = "punch"; M.hold(1, { "rp" }) end)
M.at(base + 712, function() label = "after-punch"; M.hold(1, {}) end)
M.at(base + 800, function() M.snap("end"); csv:close(); on = false; M.log("DONE") end)
M.at(base + 515, function() M.snap("launcher") end)
M.at(base + 545, function() M.snap("launcher+35") end)
M.at(base + 575, function() M.snap("launcher+65") end)

M.run(function(n)
  if not on then return end
  csv:write(string.format("%d,%s,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\n", n, label,
    s32(P1X), s32(P1X + 4), s32(P1X + 8),
    s32(P2X), s32(P2X + 4), s32(P2X + 8),
    s32(BAR), s32(ANIM), s32(FRAMEC), s32(STATE)))
end)
