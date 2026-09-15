-- Tekken 3's health, using the health *bar* as the oracle for when damage has actually landed.
--
-- Every previous attempt sampled on a schedule and hoped a punch had connected in between. The bar
-- geometry at 0x25fdec-0x25fe5c is already known to shrink when damage lands — it is what proved
-- the punches were connecting at all — so this waits for that to move before taking each sample.
-- The measurement can then never be of a round in which nothing happened, which is what spoiled
-- three earlier runs in three different ways.
--
-- The analysis lessons from Model 2 are baked into `hp.mjs`: scan 16-bit halves, because health can
-- sit beside a per-frame counter and no 32-bit word containing it ever looks still; and accept a
-- value that falls once and then holds, because demanding two falls throws the answer away when the
-- second bout of punches misses.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")
local OUT = os.getenv("PROBE_OUT") or "."

-- **Close the distance by measuring it.** Every previous attempt at Tekken's health walked forward
-- for a fixed number of frames and then punched, and the health bars in the screenshots show the
-- punches never landed — in any of them. Four different search techniques were blamed for finding
-- nothing when the truth is that nothing was ever hit.
--
-- Both fighters' x are known (0x31e15c and one struct, 0x1ae4, above it), so the gap is a number the
-- probe can read. It now walks until the fighters are genuinely close and punches then.
local P1X, P2X = 0x31e15c, 0x31e15c + 0x1ae4
local function sx(a)
  local v = M.mem:read_u32(a)
  if v >= 0x80000000 then v = v - 0x100000000 end
  return v
end
local function gap() return math.abs(sx(P2X) - sx(P1X)) end

local BAR = 0x25fe5c
local function bar() return M.mem:read_u16(BAR) end

local function dump(name)
  local data = M.mem:read_range(M.LIVE_BASE, M.LIVE_BASE + M.LIVE_SIZE - 1, 8)
  local f = assert(io.open(OUT .. "/hp-" .. name .. ".bin", "wb"))
  f:write(data)
  f:close()
  M.log("DUMP %-3s frame %d  (bar %d)", name, M.frame, bar())
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
local state, t0, barBase, hitBase = "wait", nil, nil, nil
M.at(base, function() state = "approach"; M.hold(1, { "right" }) end)

M.run(function(n)
  if state == "approach" then
    if gap() < 260 or n > base + 900 then
      M.hold(1, {})
      state = "quiet"
      t0 = n
      M.log("closed to a gap of %d after %d frames", gap(), n - base)
      M.snap("in range")
    end
  elseif state == "quiet" then
    local d = n - t0
    for i, at in ipairs({ 0, 41, 93, 148, 215, 290 }) do
      if d == at then dump("q" .. (i - 1)) end
    end
    if d == 320 then
      dump("h0")
      barBase = bar()
      hitBase = M.mem:read_u32(0x31e1a4 + 0x1ae4)
      state = "punch1"
      t0 = n
    end
  elseif state == "punch1" or state == "punch2" then
    local d = n - t0
    if d % 34 == 0 then M.hold(1, { "rp" }) end
    if d % 34 == 12 then M.hold(1, {}) end
    -- Only sample once the bar has genuinely moved.
    -- The bar quad is not a damage signal — it moved in an earlier run while both health bars
    -- stayed visibly full — so the trigger is the opponent's own state changing instead.
    if M.mem:read_u32(0x31e1a4 + 0x1ae4) ~= hitBase and d > 20 then
      M.hold(1, {})
      if state == "punch1" then
        M.at(n + 30, function() dump("h1"); M.snap("bar moved once") end)
        M.at(n + 90, function() dump("h1b") end)
        M.at(n + 120, function()
        barBase = bar()
        hitBase = M.mem:read_u32(0x31e1a4 + 0x1ae4)
        state = "punch2"
        t0 = M.frame
      end)
        state = "waiting1"
      end
    end
    if d > 700 then
      M.log("the bar never moved — no damage landed")
      M.log("DONE")
      state = "done"
    end
  elseif state == "waiting1" then
    -- handled by the scheduled callbacks above
  end
  if state == "punch2" and M.mem:read_u32(0x31e1a4 + 0x1ae4) ~= hitBase and (n - t0) > 20 then
    M.hold(1, {})
    state = "done2"
    M.at(n + 30, function()
      dump("h2")
      M.snap("bar moved twice")
      M.log("DONE")
    end)
  end
end)
