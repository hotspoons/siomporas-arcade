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

-- Input field names on the CPS1 board.
M.FIELD = {
  [1] = { up={":IN1","P1 Up"}, down={":IN1","P1 Down"}, left={":IN1","P1 Left"}, right={":IN1","P1 Right"},
          lp={":IN1","P1 Jab Punch"}, mp={":IN1","P1 Strong Punch"}, hp={":IN1","P1 Fierce Punch"},
          lk={":IN2","P1 Short Kick"}, mk={":IN2","P1 Forward Kick"}, hk={":IN2","P1 Roundhouse Kick"},
          start={":IN0","1 Player Start"} },
  [2] = { up={":IN1","P2 Up"}, down={":IN1","P2 Down"}, left={":IN1","P2 Left"}, right={":IN1","P2 Right"},
          lp={":IN1","P2 Jab Punch"}, mp={":IN1","P2 Strong Punch"}, hp={":IN1","P2 Fierce Punch"},
          lk={":IN2","P2 Short Kick"}, mk={":IN2","P2 Forward Kick"}, hk={":IN2","P2 Roundhouse Kick"},
          start={":IN0","2 Players Start"} },
}

function M.set(port, name, v) M.ports[port].fields[name]:set_value(v) end
function M.coin(v) M.set(":IN0", "Coin 1", v) end
-- Hold a set of named inputs for player p; everything not named is released.
function M.hold(p, names)
  local want = {}
  for _, k in ipairs(names) do want[k] = true end
  for k, f in pairs(M.FIELD[p]) do if k ~= "start" then M.set(f[1], f[2], want[k] and 1 or 0) end end
end
function M.release_all()
  for p = 1, 2 do M.hold(p, {}) end
  M.set(":IN0", "1 Player Start", 0); M.set(":IN0", "2 Players Start", 0); M.coin(0)
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
if M.IS_WW then
  M.ADDR.p1 = 0xFF83C6; M.ADDR.p2 = 0xFF86C6; M.ADDR.projectile = 0xFF938A; M.ADDR.screen_left = 0xFF8BD8
  M.ADDR.timer = 0xFF8ACE; M.ADDR.timer_sub = 0xFF8ACF
end

function M.match_active() return (M.mem:read_u16(M.ADDR.match_flags) & 0x08) ~= 0 end

function M.snapshot(tag) manager.machine.video:snapshot(); if tag then print("SNAP " .. tag) end end

function M.log(fmt, ...) print(string.format(fmt, ...)) end

return M
