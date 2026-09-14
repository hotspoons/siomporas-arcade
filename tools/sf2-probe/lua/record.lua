-- Move recorder. Loads a match savestate, runs a plan of scripted tests against a controlled P2
-- dummy, and writes one JSON line per frame per test to $PROBE_OUT/<plan>.jsonl.
--
--   PROBE_STATE=match_ryu_zangief PROBE_PLAN=plans/ryu.lua mame sf2ceea ... -autoboot_script record.lua
--
-- A plan file returns { name=..., tests={ {name=, dist=, p2=, seq={{frames,"inputs"},...}, frames=N}, ... } }.
-- p2 modes: "stand" | "crouch" | "block" (hold back) | "cblock" (hold down-back) | "jump" | "downafter"
-- (stand, then hold down from the first frame the dummy is in a reaction — measures actionability).
-- Inputs are comma separated names from common.lua FIELD: up down left right lp mp hp lk mk hk;
-- "fwd"/"back" are resolved by P1's facing at the start of the test.
PROBE_DIR = os.getenv("PROBE_DIR") or "."
local C = dofile(PROBE_DIR .. "/common.lua")
local mem = C.mem
local A = C.ADDR
local plan = dofile(os.getenv("PROBE_PLAN"))
local state_name = os.getenv("PROBE_STATE") or "match_ryu_zangief"
local out_dir = os.getenv("PROBE_OUT") or "."
local out = assert(io.open(string.format("%s/%s.jsonl", out_dir, plan.name), "w"))
local RESET_X = plan.reset_x or 520

-- ---------------------------------------------------------------- object readers
local P = { [1] = A.p1, [2] = A.p2 }
local function rd8(a) return mem:read_u8(a) end
local function rd16(a) return mem:read_i16(a) end
local function rd32(a) return mem:read_u32(a) end

local BOX_LIST = C.BOX_LIST

-- Boxes in the game's native object space: centre (cx, cy) and radii, cx positive = BEHIND the
-- fighter (the sprites face left natively), cy positive = up from the feet.
local function read_boxes(base, anim, hbp, is_proj)
  local t = {}
  for _, e in ipairs(BOX_LIST) do
    local id = rd8(anim + e.id)
    if id ~= 0 then
      local tab = hbp + rd16(hbp + e.tab)
      local a = tab + id * e.sz
      local cx = mem:read_i8(a)
      if e.type == "atk" then
        local x2 = rd8(a + 5)
        if x2 >= 0x80 then cx = -x2 end
      end
      local extra = ""
      if e.type == "atk" then
        extra = string.format(',"raw":"%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x"',
          rd8(a),rd8(a+1),rd8(a+2),rd8(a+3),rd8(a+4),rd8(a+5),rd8(a+6),rd8(a+7),rd8(a+8),rd8(a+9),rd8(a+10),rd8(a+11))
      end
      t[#t+1] = string.format('{"t":"%s","id":%d,"cx":%d,"cy":%d,"rx":%d,"ry":%d%s}',
        e.type, id, cx, mem:read_i8(a + 1), rd8(a + 2), rd8(a + 3), extra)
    end
  end
  return "[" .. table.concat(t, ",") .. "]"
end

local function hexrange(a, n)
  local t = {}
  for i = 0, n - 1 do t[#t+1] = string.format("%02x", rd8(a + i)) end
  return table.concat(t)
end

-- The sprites drawn around this fighter, from whichever list this board keeps (see common.lua).
local function read_obj(b)
  return C.objects(rd16(b + 0x06) - rd16(A.screen_left) + 64)
end

local function read_player(p)
  local b = P[p]
  local anim = rd32(b + 0x1A)
  local hbp = rd32(b + 0x34)
  return string.format(
    '{"x":%d,"y":%d,"fl":%d,"st":%d,"sub":%d,"an":"%06x","dur":%d,"hp":%d,"frz":%d,"vx":%d,"vy":%d,"stun":%d,"stunT":%d,"thr":[%d,%d,%d,%d],"thrable":[%d,%d],"rec":"%s","bx":%s,"obj":%s,"r0":"%s","r1":"%s"}',
    rd16(b + 0x06), rd16(b + 0x0A), rd8(b + 0x12), rd8(b + 0x03), rd8(b + 0x04), anim, rd8(b + 0x19),
    rd16(b + 0x2A), rd8(b + 0x47), mem:read_i32(b + 0x1C4), mem:read_i32(b + 0x1C8), rd8(b + 0x5F), rd8(b + 0x5D),
    rd16(b + 0x64), rd16(b + 0x66), rd16(b + 0x68), rd16(b + 0x6A), rd16(b + 0x6C), rd16(b + 0x6E),
    hexrange(anim, 0x18), read_boxes(b, anim, hbp, false), read_obj(b),
    hexrange(b + 0x40, 0x60), hexrange(b + 0x100, 0xD0))
end

local function read_projectiles()
  local t = {}
  for i = 0, A.max_projectiles - 1 do
    local b = A.projectile + i * A.projectile_space
    if mem:read_u16(b) == 0x0101 then
      local anim = rd32(b + 0x1A)
      local hbp = rd32(b + 0x34)
      t[#t+1] = string.format('{"i":%d,"x":%d,"y":%d,"fl":%d,"st":%d,"an":"%06x","dur":%d,"vx":%d,"vxf":%d,"rec":"%s","bx":%s,"r0":"%s"}',
        i, rd16(b + 0x06), rd16(b + 0x0A), rd8(b + 0x12), rd8(b + 0x03), anim, rd8(b + 0x19),
        rd16(b + 0x1C4), rd8(b + 0x1C6), hexrange(anim, 0x18), read_boxes(b, anim, hbp, true), hexrange(b, 0x60))
    end
  end
  return "[" .. table.concat(t, ",") .. "]"
end

-- ---------------------------------------------------------------- training-mode pokes
local function freeze_timer() mem:write_u8(A.timer_sub, 0x28) end
local function set_health(p, v)
  local b = P[p]
  mem:write_i16(b + 0x2A, v); mem:write_i16(b + 0x2C, v); mem:write_i16(b + 0x1BC, v)
end
local function teleport(p, x) mem:write_i16(P[p] + 0x06, x); mem:write_i16(P[p] + 0x1CC, x) end
C.teleport = teleport; C.set_health = set_health

-- ---------------------------------------------------------------- input resolution
local function split(s)
  local t = {}
  for w in string.gmatch(s or "", "[^,%s]+") do t[#t+1] = w end
  return t
end
local function resolve(names, facing_right)
  local out = {}
  for _, k in ipairs(names) do
    if k == "fwd" then out[#out+1] = facing_right and "right" or "left"
    elseif k == "back" then out[#out+1] = facing_right and "left" or "right"
    else out[#out+1] = k end
  end
  return out
end

-- ---------------------------------------------------------------- test driver
local n, ti, phase, t = 0, 0, "load", 0
local test, seq_i, seq_left, p1_facing_right, p2_reacted, p2_rev
local total = #plan.tests

local function neutral(p)
  local b = P[p]
  return rd8(b + 0x03) == 0 and rd8(b + 0x47) == 0 and rd16(b + 0x0A) == 40 and mem:read_i32(b + 0x1C4) == 0
end
local function place()
  local x1 = test.x1 or RESET_X
  teleport(1, x1); teleport(2, x1 + (test.dist or 80))
  for p = 1, 2 do mem:write_i32(P[p] + 0x1C4, 0); mem:write_i32(P[p] + 0x1C8, 0) end
  set_health(1, 144); set_health(2, 144)
end
local function begin_test()
  ti = ti + 1
  test = plan.tests[ti]
  if not test then out:close(); C.log("RECORD done %d tests", total); manager.machine:exit(); return end
  phase = "reset"; t = 0; seq_i = 1; seq_left = nil; p2_reacted = false
  C.release_all()
  if test.setup then test.setup(C, P) end
end

-- P2 has been touched by the move: hit/block freeze, hit reaction, thrown, or knocked down.
-- Only once the reaction state has actually begun: switching the dummy's stick on the freeze frame
-- itself lets the game read "up" while it enters the reaction and turns a stagger into an air reset.
local function p2_touched()
  local st = rd8(P[2] + 0x03)
  return st == 0x0E or st == 0x14 or (test.throw and rd16(P[2] + 0x0A) ~= 40)
end

-- The dummy's inputs before and after being touched. Old string modes map onto {pre, post}.
local MODES = {
  stand = {{}, {}}, crouch = {{"down"}, {"down"}}, block = {{"back"}, {"back"}}, cblock = {{"down","back"}, {"down","back"}},
  downafter = {{}, {"down"}}, blockdown = {{"back"}, {"down"}}, upafter = {{}, {"up"}}, blockup = {{"back"}, {"up","back"}},
  cblockup = {{"down","back"}, {"up","back"}}, crouchup = {{"down"}, {"up"}}, jump = {{"up"}, {"up"}},
}

emu.register_frame_done(function()
  n = n + 1
  if n == 2 then manager.machine:load(state_name) end
  if n < 6 then return end
  if phase == "load" then
    if not C.match_active() then return end
    C.log("RECORD plan=%s state=%s", plan.name, state_name)
    begin_test(); return
  end
  if not C.no_timer_freeze then freeze_timer() end
  if phase == "reset" then
    t = t + 1
    -- wait (up to 400 frames) for both fighters to be standing still and free, then place them
    if t >= 4 and (neutral(1) and neutral(2) or t > 400) then
      place(); phase = "settle"; t = 0
    end
    return
  elseif phase == "settle" then
    t = t + 1
    if t == 1 then place() end
    if t >= (test.settle or 14) then
      phase = "run"; t = 0
      p1_facing_right = rd8(P[1] + 0x12) == 1
      C.log("TEST %d/%d %s dist=%d x1=%d x2=%d fl1=%d", ti, total, test.name, test.dist or 80, rd16(P[1]+6), rd16(P[2]+6), rd8(P[1]+0x12))
    end
    return
  end
  -- phase == run
  t = t + 1
  -- P1 script
  local in1 = {}
  if seq_i <= #test.seq then
    local step = test.seq[seq_i]
    if seq_left == nil then seq_left = step[1] end
    in1 = resolve(split(step[2]), p1_facing_right)
    seq_left = seq_left - 1
    if seq_left <= 0 then seq_i = seq_i + 1; seq_left = nil end
  end
  C.hold(1, in1)
  -- P2 dummy. P2 faces P1, so its "back" is away from P1.
  local p2_back = (rd16(P[2] + 6) > rd16(P[1] + 6)) and "right" or "left"
  if p2_touched() then p2_reacted = true end
  local mode = test.p2 or "stand"
  local spec = type(mode) == "table" and mode or MODES[mode]
  local in2 = {}
  if mode == "custom" then in2 = test.p2_inputs(t, p2_reacted, p2_back)
  else
    for _, k in ipairs(p2_reacted and spec[2] or spec[1]) do in2[#in2+1] = (k == "back") and p2_back or ((k == "fwd") and (p2_back == "right" and "left" or "right") or k) end
  end
  C.hold(2, in2)
  if test.each then test.each(t, C, P, p2_reacted) end
  C.hold(2, in2)
  -- record
  out:write(string.format('{"test":"%s","f":%d,"in1":"%s","in2":"%s","timer":"%02x","scr":%d,"p1":%s,"p2":%s,"proj":%s}\n',
    test.name, t, table.concat(in1, ","), table.concat(in2, ","), rd8(A.timer), rd16(A.screen_left),
    read_player(1), read_player(2), read_projectiles()))
  local done = t >= (test.frames or 120)
  if not done and test.until_free and t > 8 and neutral(1) and (not p2_reacted or rd8(P[2]+3) ~= 0x0E) then done = t >= (test.min_frames or 30) end
  if done then
    if test.snap then C.snapshot(test.name) end
    begin_test()
  end
end)
