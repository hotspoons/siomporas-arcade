-- Everything that happens TO a fighter, which is the half its own recording cannot show: the
-- dummy is the one being hit, so a character's flinches, guards, knockdown and dizzy come from a
-- run where it is player two.
--
--   PROBE_STATE=match_zangief_ryu PROBE_PLAN=tools/sf2-probe/lua/plans/react.lua ... record.lua
--
-- Player one is whoever the state was booted with and only has to land the blows; the test names
-- keep the <move>__<variant>__<rep> shape the rest of the tooling reads.
PROBE_DIR = os.getenv("PROBE_DIR") or "."
local T = {}
local function add(t) T[#T+1] = t end
local close, far = 40, 72

add{name="calib-idle__whiff__1", dist=140, seq={}, frames=48}
-- hits: standing, from a distance, and against a crouching guard
add{name="stand-hp__hit__1",    dist=close, p2="upafter",  seq={{2,"hp"}}, frames=140}
add{name="stand-hp__fhit__1",   dist=far,   p2="upafter",  seq={{2,"hp"}}, frames=140}
add{name="stand-lp__hit__1",    dist=close, p2="upafter",  seq={{2,"lp"}}, frames=120}
-- a jab first: a fierce into a crouching guard knocks them over, which is a different animation
add{name="stand-lp__chit__1",   dist=close, p2="crouchup", seq={{2,"lp"}}, frames=140}
add{name="stand-hp__chit__1",   dist=close, p2="crouchup", seq={{2,"hp"}}, frames=140}
add{name="crouch-hp__chit__1",  dist=close, p2="crouchup", seq={{4,"down"},{2,"down,hp"},{40,"down"}}, frames=140}
-- guards, high and low
add{name="stand-lp__block__1",  dist=close, p2="blockup",  seq={{2,"lp"}}, frames=140}
add{name="stand-hp__block__1",  dist=close, p2="blockup",  seq={{2,"hp"}}, frames=140}
add{name="stand-hk__block__1",  dist=far,   p2="blockup",  seq={{2,"hk"}}, frames=140}
add{name="crouch-lk__cblock__1", dist=close, p2="cblockup", seq={{4,"down"},{2,"down,lk"},{40,"down"}}, frames=140}
add{name="crouch-hk__cblock__1", dist=close, p2="cblockup", seq={{4,"down"},{2,"down,hk"},{40,"down"}}, frames=140}
-- the sweep knocks them down: the fall, the floor and the wake-up are one animation
add{name="crouch-hk__hit__1",   dist=close, p2="stand", seq={{4,"down"},{2,"down,hk"},{40,"down"}}, frames=220}
add{name="crouch-hk__hit__2",   dist=far,   p2="stand", seq={{4,"down"},{2,"down,hk"},{40,"down"}}, frames=220}
-- the throw, from the wrong end of it
for r = 1, 2 do add{name="throw-fwd-hp__hit__"..r, dist=40, p2="upafter", seq={{3,"fwd,hp"}}, frames=260, throw=true} end
-- and stars, which need the meter nearly full first: a fierce on top of 29 points always dizzies,
-- and waiting for fourteen honest punches to do it does not (the meter drains between them)
add{name="dizzy-force__hit__1", dist=close, p2="stand", frames=420, seq={{2,"hp"},{380,""}},
  each=function(t, C, P) if t < 3 then C.mem:write_u8(P[2] + 0x5F, 29); C.mem:write_u8(P[2] + 0x5D, 200) end end}
add{name="dizzy-hp__hit__1", dist=close, p2="stand", frames=700,
  seq=(function() local s={} for i=1,14 do s[#s+1]={2,"hp"}; s[#s+1]={46,""} end return s end)(),
  each=function(t, C, P) if C.mem:read_u8(P[1]+3) == 0 and C.mem:read_u8(P[2]+3) == 0 then C.teleport(2, C.mem:read_i16(P[1]+6) + close); C.set_health(2, 144) end end}

return { name = os.getenv("PROBE_PLAN_NAME") or "react", tests = T }
