-- Does Virtua Fighter 2 give you more than one jump?
--
-- Holding "up" for four or eight frames puts the fighter in the air on frame ten; holding it for
-- fourteen or thirty puts him there on frame fourteen. Two different startups means two different
-- jumps, which would be a mechanic Street Fighter II does not have — there the jump is one fixed
-- arc whatever you do. This measures the arc each hold actually produces.
package.path = (os.getenv("PROBE_DIR") or ".") .. "/?.lua;" .. package.path
local M = require("common")

local W = M.WORKRAM
local Y, X = 0x1099c, 0x10f7c
local function f32(a)
  local x = (string.unpack("<f", string.pack("<I4", W:read_u32(a) & 0xFFFFFFFF)))
  if x ~= x then return 0 end
  return x
end

local f = 900
for _ = 1, 8 do f = M.tapCoin(f + 100, 20) end
f = M.tapStart(f + 120, 1, 10)
f = M.tapStart(f + 60, 2, 10)
for i = 0, 6 do
  M.tap(f + 150 + i * 45, 1, { "p" }, 6)
  M.tap(f + 170 + i * 45, 2, { "p" }, 6)
end

local HOLDS = { 3, 6, 10, 16, 30 }
local base = f + 620
local cur, trace, startFrame = nil, nil, nil

for i, len in ipairs(HOLDS) do
  local at = base + (i - 1) * 280
  M.at(at, function()
    M.hold(1, { "up" })
    cur, trace, startFrame = len, {}, M.frame
  end)
  M.at(at + len, function() M.hold(1, {}) end)
  M.at(at + 250, function()
    if not trace or #trace == 0 then
      M.log("hold %2d: never left the ground", len)
    else
      local apex, ai = 0, 0
      for k, v in ipairs(trace) do if v > apex then apex, ai = v, k end end
      local d = {}
      for k = 2, #trace do d[#d + 1] = trace[k] - trace[k - 1] end
      local g, spread = 0, 0
      if #d > 2 then
        local dd = {}
        for k = 2, #d do dd[#dd + 1] = d[k] - d[k - 1] end
        table.sort(dd)
        g = dd[math.floor(#dd / 2) + 1]
        spread = dd[#dd] - dd[1]
      end
      M.log("hold %2d frames: airborne %3d frames, first y %.3f, apex %.3f at frame %d, gravity %.5f (spread %.5f)",
        len, #trace, trace[1], apex, ai, g, spread)
    end
    cur = nil
  end)
end
M.at(base + 5 * 280 + 40, function() M.log("DONE") end)

M.run(function(n)
  if cur and trace then
    local y = f32(Y)
    if y ~= 0 then trace[#trace + 1] = y end
  end
end)
