-- input-timing experiments for charge / mash / three-button specials
local T = {}
local function add(t) T[#T+1] = t end
local ch = os.getenv("PROBE_CHAR")
if ch == "blanka" then
  add{name="roll_a__whiff__1", dist=200, seq={{70,"back"},{2,"fwd,hp"}}, frames=120}
  add{name="roll_b__whiff__1", dist=200, seq={{70,"back"},{1,"fwd"},{2,"fwd,hp"}}, frames=120}
  add{name="roll_c__whiff__1", dist=200, seq={{100,"back"},{3,"fwd,hp"}}, frames=120}
  add{name="roll_d__whiff__1", dist=200, seq={{70,"down,back"},{2,"fwd,hp"}}, frames=120}
  add{name="roll_e__whiff__1", dist=200, seq={{70,"back"},{1,""},{2,"hp"}}, frames=120}
  add{name="roll_f__whiff__1", dist=200, seq={{70,"back"},{2,"fwd"},{1,"fwd,hp"},{2,"fwd"}}, frames=120}
  add{name="vert_a__whiff__1", dist=200, seq={{70,"down"},{2,"up,hk"}}, frames=120}
  add{name="vert_b__whiff__1", dist=200, seq={{70,"down"},{1,"up"},{2,"up,hk"}}, frames=120}
  add{name="vert_c__whiff__1", dist=200, seq={{70,"down"},{1,""},{2,"hk"}}, frames=120}
  add{name="vert_d__whiff__1", dist=200, seq={{70,"down,back"},{2,"up,hk"}}, frames=120}
  add{name="elec_a__whiff__1", dist=200, seq=(function() local s={} for i=1,8 do s[#s+1]={2,"lp"}; s[#s+1]={2,""} end return s end)(), frames=120}
  add{name="elec_b__whiff__1", dist=200, seq=(function() local s={} for i=1,8 do s[#s+1]={3,"hp"}; s[#s+1]={3,""} end return s end)(), frames=120}
  add{name="elec_c__whiff__1", dist=200, seq=(function() local s={} for i=1,10 do s[#s+1]={1,"lp"}; s[#s+1]={1,""} end return s end)(), frames=120}
  add{name="elec_d__whiff__1", dist=200, seq=(function() local s={} for i=1,8 do s[#s+1]={2,"hp"}; s[#s+1]={4,""} end return s end)(), frames=120}
else
  add{name="klariat_a__whiff__1", dist=200, seq={{3,"lk,mk,hk"},{1,""}}, frames=120}
  add{name="klariat_b__whiff__1", dist=200, seq={{1,"lk"},{3,"lk,mk,hk"},{1,""}}, frames=120}
  add{name="klariat_c__whiff__1", dist=200, seq={{6,"lk,mk,hk"},{1,""}}, frames=120}
  add{name="spd_a__whiff__1", dist=200, seq={{2,"fwd"},{2,"down,fwd"},{2,"down"},{2,"down,back"},{2,"back"},{2,"up,back"},{2,"up,hp"},{1,"hp"}}, frames=120}
  add{name="spd_b__whiff__1", dist=200, seq={{1,"fwd"},{1,"down,fwd"},{1,"down"},{1,"down,back"},{1,"back"},{1,"up,back"},{1,"up,hp"},{1,"hp"}}, frames=120}
  add{name="spd_c__whiff__1", dist=200, seq={{2,"back"},{2,"down,back"},{2,"down"},{2,"down,fwd"},{2,"fwd"},{2,"up,fwd"},{2,"up,hp"}}, frames=120}
end
return { name = "inputs_" .. ch, tests = T }
