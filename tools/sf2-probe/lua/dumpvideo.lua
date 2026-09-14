-- The same dump as dumpgfx.lua, for a board whose graphics region is called something else.
--   PROBE_REGION=:video PROBE_TAG=mk PROBE_SECONDS=40 tools/sf2-probe/run.sh dumpvideo.lua mk
local OUT = os.getenv("PROBE_OUT") or "."
local TAG = os.getenv("PROBE_TAG") or "dump"
local REGION = os.getenv("PROBE_REGION") or ":gfx"
local AT = tonumber(os.getenv("PROBE_SHOT_AT") or "1200")
local n = 0
emu.register_frame_done(function()
  n = n + 1
  if n ~= AT then if n > AT + 10 then manager.machine:exit() end return end
  local r = manager.machine.memory.regions[REGION]
  local f = io.open(OUT .. "/" .. TAG .. ".bin", "wb")
  local chunk, parts = {}, 0
  for o = 0, r.size - 4, 4 do
    parts = parts + 1
    chunk[parts] = string.pack("<I4", math.floor(r:read_u32(o)))
    if parts == 16384 then f:write(table.concat(chunk)); chunk = {}; parts = 0 end
  end
  if parts > 0 then f:write(table.concat(chunk, "", 1, parts)) end
  f:close()
  local pal = manager.machine.palettes[":palette"]
  local cols = {}
  for i = 0, pal.entries - 1 do cols[#cols + 1] = string.format("%d", pal:pen_color(i) & 0xFFFFFF) end
  local pf = io.open(OUT .. "/" .. TAG .. "-palette.json", "w")
  pf:write('{"entries":' .. pal.entries .. ',"colors":[' .. table.concat(cols, ",") .. ']}')
  pf:close()
  manager.machine.video:snapshot()
  print(string.format("DUMP %s %s %d bytes, palette %d", TAG, REGION, r.size, pal.entries))
  manager.machine:exit()
end)
