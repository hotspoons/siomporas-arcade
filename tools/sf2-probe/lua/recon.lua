-- What does this board look like from the outside? Prints the regions and shares a decoder would
-- have to work with, feeds it a coin and a start, and takes a picture.
--
--   PROBE_SECONDS=40 tools/sf2-probe/run.sh recon.lua mk
--
-- The point is to find out how far the Street Fighter II tooling travels: every one of these games
-- keeps its sprites somewhere, and the question each time is whether there is a graphics region to
-- decode and a list in RAM saying what is drawn where.
local n = 0
local SHOT = tonumber(os.getenv("PROBE_SHOT_AT") or "1200")
local function coin(v)
  for _, name in ipairs({ "Coin 1", "Coin A", "Coin" }) do
    for tag, port in pairs(manager.machine.ioport.ports) do
      local f = port.fields[name]
      if f then f:set_value(v) end
    end
  end
end
local function start(v)
  for _, name in ipairs({ "1 Player Start", "P1 Start", "Start 1" }) do
    for tag, port in pairs(manager.machine.ioport.ports) do
      local f = port.fields[name]
      if f then f:set_value(v) end
    end
  end
end
emu.register_frame_done(function()
  n = n + 1
  if n == 1 then
    print("== " .. emu.gamename())
    for tag, r in pairs(manager.machine.memory.regions) do print(string.format("region %-16s %d", tag, r.size)) end
    for tag, r in pairs(manager.machine.memory.shares) do print(string.format("share  %-16s %d", tag, r.size)) end
    for tag, s in pairs(manager.machine.screens) do print(string.format("screen %-16s %dx%d", tag, s.width, s.height)) end
    for tag, d in pairs(manager.machine.devices) do if tag:match("cpu") or tag:match("dsp") then print("cpu    " .. tag) end end
    for tag, p in pairs(manager.machine.palettes) do print(string.format("palette %-15s %d entries", tag, p.entries)) end
  end
  if n == 300 or n == 340 then coin(1) end
  if n == 305 or n == 345 then coin(0) end
  if n == 600 or n == 900 then start(1) end
  if n == 610 or n == 910 then start(0) end
  if n == SHOT or n == SHOT + 600 then manager.machine.video:snapshot(); print("SNAP at " .. n) end
  if n >= SHOT + 620 then manager.machine:exit() end
end)
