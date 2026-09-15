-- Find health on Model 2, which is the instrument every frame-data measurement needs.
--
-- Two earlier attempts failed in ways worth recording. The first walked in and punched from out of
-- range. The second connected — the health bar shows the damage — but took its second sample after
-- the **round had already reset**, which puts health back to full and makes "fell twice" impossible
-- by construction. The approach alone costs about a thousand frames, twenty-one seconds of a thirty
-- second round, so the whole measurement now happens after it rather than around it.
--
-- The filter is the one that worked on Tekken 3: a word that does nothing through a quiet stretch,
-- falls when a fist arrives, and then does nothing again. Stillness is the discriminating property.
-- Health is checked as an integer **and** as a float, because this board keeps its geometry in IEEE
-- singles and there is no reason to assume the health does not follow.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local SIZE = W.size
local GAP = 0x10f78
local function f32v(v)
  local x = (string.unpack("<f", string.pack("<I4", v & 0xFFFFFFFF)))
  if x ~= x or x == math.huge or x == -math.huge then return nil end
  return x
end
local function gapNow()
  return f32v(W:read_u32(GAP)) or 0
end
local function grab()
  local t = {}
  for a = 0, SIZE - 4, 4 do t[a] = W:read_u32(a) end
  return t
end

local quiet, before, after1, after2 = {}, nil, nil, nil
local phase, punches, quietAt = "wait", 0, nil

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

-- Close the distance first, immediately, and do everything else in what is left of the round.
M.at(f + 620, function() phase = "approach"; M.hold(1, { "right" }) end)

local function report()
  M.log("=== %d punches thrown ===", punches)
  if not after2 then M.log("did not get two bouts of damage inside one round"); M.log("DONE"); return end

  -- Health is very likely **16-bit**, and that is why a 32-bit pass finds nothing: a half-word that
  -- sits next to anything busy makes the whole enclosing word look unsettled, so the real answer is
  -- filtered out before it is ever compared. Each word is therefore also split into its two halves.
  local half = 0
  for a = 0, SIZE - 4, 4 do
    for _, shift in ipairs({ 0, 16 }) do
      local function h(t) return (t[a] >> shift) & 0xFFFF end
      local q = h(quiet[1])
      local still = true
      for i = 2, #quiet do if h(quiet[i]) ~= q then still = false break end end
      if still then
        local v0, v1, v2 = h(before), h(after1), h(after2)
        if v0 > v1 and v1 >= v2 and v0 > 8 and v0 < 1024 then
          local ratio = v1 / v0
          if ratio > 0.85 and ratio < 0.90 then
            half = half + 1
            if half <= 20 then
              M.log("  16-bit 0x%05x%s  %d -> %d -> %d   lost %d (%.3f)  <== the bar's own proportion",
                a, shift == 0 and " lo" or " hi", v0, v1, v2, v0 - v2, ratio)
            end
          end
        end
      end
    end
  end
  M.log("%d half-words fell by the eighth the bar did", half)

  local n = 0
  for a = 0, SIZE - 4, 4 do
    local q = quiet[1][a]
    local still = true
    for i = 2, #quiet do if quiet[i][a] ~= q then still = false break end end
    if still then
      local v0, v1, v2 = before[a], after1[a], after2[a]
      -- Fell at least once and never recovered. The earlier version of this demanded two falls,
      -- which sounds stricter and is simply wrong: the health bar shows the second bout of punches
      -- missed entirely, so the true answer fell once and then held, and the filter excluded it.
      -- as a plain integer
      if v0 > v1 and v1 >= v2 and v0 > 0 and v0 < 4096 then
        n = n + 1
        -- The bar on screen went from 171 green pixels to 150, a loss of an eighth. Whatever health
        -- is, it fell in that proportion, so flag anything that did.
        local ratio = v1 / v0
        local mark = (ratio > 0.85 and ratio < 0.90) and "   <== fell by the same eighth the bar did" or ""
        if n <= 60 then M.log("  int   0x%05x  %d -> %d -> %d   lost %d (%.3f)%s", a, v0, v1, v2, v0 - v2, ratio, mark) end
      else
        -- or as a float, which is how this board stores nearly everything else
        local a0, a1, a2 = f32v(v0), f32v(v1), f32v(v2)
        if a0 and a1 and a2 and a0 > a1 and a1 >= a2 and a0 > 0.5 and a0 < 4096 then
          n = n + 1
          if n <= 22 then M.log("  float 0x%05x  %.3f -> %.3f -> %.3f   lost %.3f", a, a0, a1, a2, a0 - a2) end
        end
      end
    end
  end
  M.log("%d words were frozen through the quiet and then fell twice", n)
  M.log("DONE")
end

M.run(function(n)
  if phase == "approach" then
    if gapNow() < 2.2 then
      M.hold(1, {})
      phase = "quiet"
      quietAt = n + 20
      M.snap("in range")
    end
  elseif phase == "quiet" then
    -- Five samples at irregular gaps, standing perfectly still, all inside this round.
    for _, at in ipairs({ 0, 27, 61, 98, 140 }) do
      if n == quietAt + at then quiet[#quiet + 1] = grab() end
    end
    if n == quietAt + 160 then
      before = grab()
      phase = "punch"
    end
  elseif phase == "punch" or phase == "punch2" then
    if n % 28 == 0 then
      M.hold(1, { "p" })
      punches = punches + 1
    elseif n % 28 == 12 then
      M.hold(1, {})
    end
    if phase == "punch" and punches == 4 and n % 28 == 20 then
      after1 = grab()
      phase = "punch2"
      M.snap("after four")
    elseif phase == "punch2" and punches == 8 and n % 28 == 20 then
      after2 = grab()
      M.hold(1, {})
      M.snap("after eight")
      phase = "done"
      report()
    end
  end
end)
