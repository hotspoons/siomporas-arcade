-- Shared helpers for the sf2-probe MAME Lua scripts. Loaded with dofile() by every entry script;
-- MAME's autoboot_script runs with cwd = wherever mame was launched, so the entry scripts set
-- PROBE_DIR before including this.
local M = {}

M.cpu   = manager.machine.devices[":maincpu"]
M.mem   = M.cpu.spaces["program"]
M.ports = manager.machine.ioport.ports

-- Character ids as the game numbers them (select-screen order is different).
M.CHARS = { ryu=0, honda=1, blanka=2, guile=3, ken=4, chunli=5, zangief=6, dhalsim=7, bison=8, sagat=9, balrog=10, vega=11 }
M.CHAR_NAMES = {}
for k, v in pairs(M.CHARS) do M.CHAR_NAMES[v] = k end
-- Select-screen grid (col, row) per char id. Row 0: Ryu Honda Blanka Guile Balrog Vega. Row 1: Ken Chun Zangief Dhalsim Sagat Bison.
M.GRID = { [0]={0,0}, [1]={1,0}, [2]={2,0}, [3]={3,0}, [10]={4,0}, [11]={5,0},
           [4]={0,1}, [5]={1,1}, [6]={2,1}, [7]={3,1}, [9]={4,1}, [8]={5,1} }

-- Inputs, found rather than named. A CPS1 board calls its buttons "P1 Jab Punch"; its successor
-- calls them "P1 Button 1"; another board will call them something else again. So each action
-- lists the names it might go by and the first one that exists on this machine wins.
local WANTED = {
  up = { "Up" }, down = { "Down" }, left = { "Left" }, right = { "Right" },
  lp = { "Jab Punch", "Button 1" }, mp = { "Strong Punch", "Button 2" }, hp = { "Fierce Punch", "Button 3" },
  lk = { "Short Kick", "Button 4" }, mk = { "Forward Kick", "Button 5" }, hk = { "Roundhouse Kick", "Button 6" },
}

local function findField(...)
  for _, name in ipairs({ ... }) do
    for tag, port in pairs(M.ports) do
      if port.fields[name] then return { tag, name } end
    end
  end
  return nil
end

M.FIELD = { {}, {} }
M.MISSING = {}
for p = 1, 2 do
  for action, names in pairs(WANTED) do
    local tries = {}
    for _, n in ipairs(names) do tries[#tries + 1] = string.format("P%d %s", p, n) end
    local f = findField(table.unpack(tries))
    if f then M.FIELD[p][action] = f else M.MISSING[#M.MISSING + 1] = string.format("P%d %s", p, action) end
  end
  M.FIELD[p].start = findField(p == 1 and "1 Player Start" or "2 Players Start")
end
M.COIN = findField("Coin 1", "Coin A", "Coin")

function M.set(port, name, v)
  local f = M.ports[port] and M.ports[port].fields[name]
  if f then f:set_value(v) end
end
local function press(f, v) if f then M.set(f[1], f[2], v) end end
function M.coin(v) press(M.COIN, v) end
function M.start(p, v) press(M.FIELD[p].start, v) end
-- Hold a set of named inputs for player p; everything not named is released.
function M.hold(p, names)
  local want = {}
  for _, k in ipairs(names) do want[k] = true end
  for k, f in pairs(M.FIELD[p]) do if k ~= "start" then press(f, want[k] and 1 or 0) end end
end
function M.release_all()
  for p = 1, 2 do M.hold(p, {}); M.start(p, 0) end
  M.coin(0)
end

-- Memory map (sf2ce / sf2hf). World Warrior (romset sf2*) keeps the same struct layout but the
-- object tables sit a little later in RAM (from dammit's hitbox viewer; timer/select verified here).
M.ROMSET = os.getenv("PROBE_ROMSET") or "sf2ceea"
M.IS_WW = M.ROMSET:match("^sf2[a-z]*$") ~= nil and not M.ROMSET:match("^sf2ce") and not M.ROMSET:match("^sf2hf")
M.ADDR = {
  match_flags = 0xFF8008,   -- bit 3 = match in progress, bit 1 = controls live
  p1 = 0xFF83BE, p2 = 0xFF86BE, player_space = 0x300,
  projectile = 0xFF9376, projectile_space = 0xC0, max_projectiles = 8,
  screen_left = 0xFF8BC4,
  timer = 0xFF8ABE, timer_sub = 0xFF8ABF, -- BCD seconds and the 40-frame sub counter
  p1_select = 0xFF894D, p2_select = 0xFF894F, -- select-screen character ids (verified by diff)
}
M.IS_ST = M.ROMSET:match("^ssf2t") ~= nil or M.ROMSET:match("^ssf2x") ~= nil
if M.IS_ST then
  -- Super Turbo: a fighter's struct is 0x400 rather than 0x300, and everything moved with it.
  M.ADDR.p1 = 0xFF844E; M.ADDR.p2 = 0xFF844E + 0x400; M.ADDR.player_space = 0x400
  M.ADDR.projectile = 0xFF97A2; M.ADDR.projectile_space = 0xC0
  M.ADDR.screen_left = 0xFF8ED4
elseif M.IS_WW then
  M.ADDR.p1 = 0xFF83C6; M.ADDR.p2 = 0xFF86C6; M.ADDR.projectile = 0xFF938A; M.ADDR.screen_left = 0xFF8BD8
  M.ADDR.timer = 0xFF8ACE; M.ADDR.timer_sub = 0xFF8ACF
end

-- Which slots of an animation record hold which box ids, and how wide an entry in each table is.
-- Champion Edition and Super Turbo agree on everything but where the attack and push tables live
-- and how big an attack entry is (both from dammit's hitbox viewer).
M.BOX_LIST = M.IS_ST and {
  { tab = 0x0, id = 0x8, sz = 4, type = "v1" },
  { tab = 0x2, id = 0x9, sz = 4, type = "v2" },
  { tab = 0x4, id = 0xA, sz = 4, type = "v3" },
  { tab = 0x6, id = 0xC, sz = 0x10, type = "atk" },
  { tab = 0x8, id = 0xD, sz = 4, type = "push" },
} or {
  { tab = 0x0, id = 0x8, sz = 4, type = "v1" },
  { tab = 0x2, id = 0x9, sz = 4, type = "v2" },
  { tab = 0x4, id = 0xA, sz = 4, type = "v3" },
  { tab = 0x6, id = 0xB, sz = 4, type = "weak" },
  { tab = 0x8, id = 0xC, sz = 0xC, type = "atk" },
  { tab = 0xA, id = 0xD, sz = 4, type = "push" },
}

-- The hardware sprite list, wherever this board keeps it. CPS1 puts it in graphics RAM, which the
-- 68000 sees at 0x910000; its sequel gave it dedicated object RAM, which only Lua's share table
-- reaches. Both are 8-byte records of x, y, tile code and attributes, and both are read the same
-- way once you have them, so this hands back the entries near a screen position and the callers
-- never learn which board they are on.
local OBJRAM = manager.machine.memory.shares[":objram1"]
function M.objects(sx, span)
  span = span or 96
  local t = {}
  if M.IS_ST and OBJRAM then
    for i = 0, (OBJRAM.size / 8) - 1 do
      local o = i * 8
      local x = OBJRAM:read_u16(o) & 0x3FF
      local code = OBJRAM:read_u16(o + 4)
      if code ~= 0 and math.abs(x - sx) <= span then
        t[#t + 1] = string.format('[%d,%d,%d,%d]', x, OBJRAM:read_u16(o + 2) & 0x3FF, code, OBJRAM:read_u16(o + 6))
      end
    end
  else
    for i = 0, 0x3FF do
      local a = 0x910000 + i * 8
      local attr = M.mem:read_u16(a + 6)
      if attr >= 0xFF00 then break end
      local x = M.mem:read_u16(a) & 0x3FF
      if x ~= 0 and math.abs(x - sx) <= span then
        t[#t + 1] = string.format('[%d,%d,%d,%d]', x, M.mem:read_u16(a + 2) & 0x3FF, M.mem:read_u16(a + 4), attr)
      end
    end
  end
  return "[" .. table.concat(t, ",") .. "]"
end

function M.match_active() return (M.mem:read_u16(M.ADDR.match_flags) & 0x08) ~= 0 end

function M.snapshot(tag) manager.machine.video:snapshot(); if tag then print("SNAP " .. tag) end end

function M.log(fmt, ...) print(string.format(fmt, ...)) end

return M
