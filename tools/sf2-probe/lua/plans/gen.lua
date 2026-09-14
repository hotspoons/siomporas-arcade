-- Builds the standard recording plan for one character. Test names are
-- <move>__<variant>__<rep>, which derive.mjs relies on.
--   variants: whiff (far away), cwhiff (close-version whiff: P2 in range, moved away once the move
--   starts), hit (standing dummy, jumps when free), block (standing block, jumps when free),
--   chit (crouching dummy), cblock (crouching block).
PROBE_DIR = os.getenv("PROBE_DIR") or "."
local chars = dofile(PROBE_DIR .. "/plans/chars.lua")
local G = {}
local BUTTONS = {"lp","mp","hp","lk","mk","hk"}
local P_BTN, K_BTN = {"lp","mp","hp"}, {"lk","mk","hk"}

local function away(t, C, P) if C.mem:read_u8(P[1] + 0x03) ~= 0 then C.teleport(2, C.mem:read_i16(P[1] + 6) + 260) end end

function G.build(charname, opts)
  opts = opts or {}
  local def = chars[charname] or {specials = {}}
  local T = {}
  local function add(t) T[#T+1] = t end
  local closeD, farD, airD = opts.closeDist or 40, opts.farDist or 72, opts.airDist or 90
  local reps = opts.reps or 3

  -- calibration
  add{name="calib-idle__whiff__1",     dist=140, seq={}, frames=48}
  add{name="calib-walkfwd__whiff__1",  dist=220, seq={{44,"fwd"}}, frames=50}
  add{name="calib-walkback__whiff__1", dist=140, seq={{44,"back"}}, frames=50}
  add{name="calib-crouch__whiff__1",   dist=140, seq={{40,"down"}}, frames=60}
  add{name="calib-jumpn__whiff__1",    dist=140, seq={{60,"up"}}, frames=75}
  add{name="calib-jumpf__whiff__1",    dist=240, seq={{4,"up,fwd"},{56,"fwd"}}, frames=75}
  add{name="calib-jumpb__whiff__1",    dist=140, x1=600, seq={{4,"up,back"},{56,"back"}}, frames=75}
  add{name="calib-landjab__whiff__1",  dist=240, seq=(function() local s={{4,"up"},{38,""}} for i=1,12 do s[#s+1]={1,"lp"}; s[#s+1]={1,""} end return s end)(), frames=70}

  -- standing normals: far whiff, close whiff, hits and blocks at close and far distance
  for _, b in ipairs(BUTTONS) do
    add{name="stand-"..b.."__whiff__1", dist=250, seq={{2,b}}, frames=70, until_free=true}
    add{name="stand-"..b.."__cwhiff__1", dist=closeD, seq={{2,b}}, frames=70, each=away, until_free=true}
    for r = 1, reps do
      add{name="stand-"..b.."__hit__"..r,  dist=closeD, p2="upafter", seq={{2,b}}, frames=120}
      add{name="stand-"..b.."__fhit__"..r, dist=farD,   p2="upafter", seq={{2,b}}, frames=120}
    end
    add{name="stand-"..b.."__block__1",  dist=closeD, p2="blockup", seq={{2,b}}, frames=120}
    add{name="stand-"..b.."__fblock__1", dist=farD,   p2="blockup", seq={{2,b}}, frames=120}
    add{name="stand-"..b.."__chit__1",   dist=closeD, p2="crouchup", seq={{2,b}}, frames=120}
    add{name="stand-"..b.."__cblock__1", dist=closeD, p2="cblockup", seq={{2,b}}, frames=120}
  end
  -- crouching normals
  for _, b in ipairs(BUTTONS) do
    add{name="crouch-"..b.."__whiff__1", dist=250, seq={{4,"down"},{2,"down,"..b},{40,"down"}}, frames=70, until_free=true}
    for r = 1, reps do
      add{name="crouch-"..b.."__hit__"..r, dist=closeD, p2="upafter", seq={{4,"down"},{2,"down,"..b},{40,"down"}}, frames=140}
      add{name="crouch-"..b.."__fhit__"..r, dist=farD, p2="upafter", seq={{4,"down"},{2,"down,"..b},{40,"down"}}, frames=140}
    end
    add{name="crouch-"..b.."__block__1",  dist=closeD, p2="blockup",  seq={{4,"down"},{2,"down,"..b},{40,"down"}}, frames=120}
    add{name="crouch-"..b.."__chit__1",   dist=closeD, p2="crouchup", seq={{4,"down"},{2,"down,"..b},{40,"down"}}, frames=140}
    add{name="crouch-"..b.."__cblock__1", dist=closeD, p2="cblockup", seq={{4,"down"},{2,"down,"..b},{40,"down"}}, frames=120}
  end
  -- jumping normals (forward jump, button pressed a little before the apex)
  for _, b in ipairs(BUTTONS) do
    local jseq = function(hold) return {{4,"up,fwd"},{hold,"fwd"},{2,"fwd,"..b},{50,""}} end
    add{name="air-"..b.."__whiff__1", dist=250, seq=jseq(14), frames=80}
    add{name="air-"..b.."__nwhiff__1", dist=250, seq={{4,"up"},{14,""},{2,b},{50,""}}, frames=80}
    -- several distance/timing combinations so at least one connects on the standing dummy
    local combos = {{70, 12}, {84, 16}, {60, 20}, {96, 10}, {66, 28}, {100, 26}, {110, 30}, {120, 32}, {96, 34}, {130, 28}}
    for r, c in ipairs(combos) do add{name="air-"..b.."__hit__"..r, dist=c[1], p2="upafter", seq=jseq(c[2]), frames=130} end
    for r, c in ipairs(combos) do add{name="air-"..b.."__block__"..r, dist=c[1], p2="blockup", seq=jseq(c[2]), frames=130} end
    add{name="air-"..b.."__chit__1", dist=70, p2="crouchup", seq=jseq(12), frames=130}
    add{name="air-"..b.."__chit__2", dist=84, p2="crouchup", seq=jseq(16), frames=130}
    add{name="air-"..b.."__chit__3", dist=110, p2="crouchup", seq=jseq(30), frames=130}
  end
  -- throws
  for _, b in ipairs({"mp","hp","mk","hk"}) do
    for _, d in ipairs({"fwd","back"}) do
      for r = 1, reps do add{name="throw-"..d.."-"..b.."__hit__"..r, dist=40, p2="upafter", seq={{3,d..","..b}}, frames=240, throw=true} end
    end
  end
  for d = 40, 110, 6 do add{name="throwrange-hp-"..d.."__probe__1", dist=d, seq={{3,"fwd,hp"}}, frames=12, until_free=false} end
  -- close/far thresholds: which animation comes out at each distance (dummy moved away at once)
  for _, b in ipairs(BUTTONS) do
    for d = 30, 100, 2 do add{name="range-"..b.."-"..d.."__probe__1", dist=d, seq={{2,b}}, frames=5, each=away} end
  end
  -- specials
  for _, sp in ipairs(def.specials) do
    local btns = sp.buttons or (sp.button == "P" and P_BTN or K_BTN)
    for _, s in ipairs(btns) do
      local seq = {}
      local bname = s
      if s == "ppp" then bname = "lp,mp,hp" elseif s == "kkk" then bname = "lk,mk,hk" end
      for _, step in ipairs(sp.motion) do seq[#seq+1] = {step[1], (step[2]:gsub("@", bname))} end
      local id = sp.id .. "-" .. s
      add{name=id.."__whiff__1", dist=260, seq=seq, frames=sp.frames or 150, until_free=true, min_frames=60}
      for r = 1, reps do add{name=id.."__hit__"..r, dist=sp.dist or 50, p2="upafter", seq=seq, frames=(sp.frames or 150) + 60} end
      add{name=id.."__block__1", dist=sp.dist or 50, p2="blockup", seq=seq, frames=(sp.frames or 150) + 60}
      add{name=id.."__chit__1", dist=sp.dist or 50, p2="crouchup", seq=seq, frames=(sp.frames or 150) + 60}
      add{name=id.."__cblock__1", dist=sp.dist or 50, p2="cblockup", seq=seq, frames=(sp.frames or 150) + 60}
    end
  end
  -- dizzy: fierce punches with the dummy walked back into range every time
  add{name="dizzy-hp__hit__1", dist=closeD, p2="stand", frames=700,
    seq=(function() local s={} for i=1,12 do s[#s+1]={2,"hp"}; s[#s+1]={50,""} end return s end)(),
    each=function(t, C, P) if C.mem:read_u8(P[1]+3) == 0 and C.mem:read_u8(P[2]+3) == 0 then C.teleport(2, C.mem:read_i16(P[1]+6) + closeD); C.set_health(2, 144) end end}
  add{name="dizzy-lp__hit__1", dist=closeD, p2="stand", frames=700,
    seq=(function() local s={} for i=1,24 do s[#s+1]={2,"lp"}; s[#s+1]={26,""} end return s end)(),
    each=function(t, C, P) if C.mem:read_u8(P[1]+3) == 0 and C.mem:read_u8(P[2]+3) == 0 then C.teleport(2, C.mem:read_i16(P[1]+6) + closeD); C.set_health(2, 144) end end}
  -- dizzy threshold: preload the dummy's stun meter and timer, then jab once
  for _, pre in ipairs({22, 25, 27, 28, 29}) do
    for r = 1, 3 do
      add{name="dizzyprobe-"..pre.."__hit__"..r, dist=closeD, p2="stand", frames=60, seq={{2,"lp"}},
        setup=function(C, P) C.mem:write_u8(P[2] + 0x5F, pre); C.mem:write_u8(P[2] + 0x5D, 200) end,
        each=function(t, C, P) if t < 3 then C.mem:write_u8(P[2] + 0x5F, pre); C.mem:write_u8(P[2] + 0x5D, 200) end end}
    end
  end
  -- round timer, unfrozen for 200 frames
  add{name="calib-timer__whiff__1", dist=140, seq={}, frames=200, setup=function(C) C.no_timer_freeze = true end}
  return { name = charname, tests = T }
end
return G
