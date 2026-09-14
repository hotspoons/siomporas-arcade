local T = {}
local function add(t) T[#T+1] = t end
add{name="vA__whiff__1", dist=200, seq={{120,"down"},{1,""},{2,"up,hk"}}, frames=200}
add{name="vB__whiff__1", dist=200, seq={{120,"down"},{2,"up"},{2,"up,hk"}}, frames=200}
add{name="vC__whiff__1", dist=200, seq={{120,"down"},{1,"up"},{1,"up,hk"},{2,"hk"}}, frames=200}
add{name="vD__whiff__1", dist=200, seq={{120,"down,back"},{2,"up,back"},{2,"up,back,hk"}}, frames=200}
add{name="vE__whiff__1", dist=200, seq={{120,"down"},{3,"up"},{2,"up,hk"}}, frames=200}
add{name="vF__whiff__1", dist=200, seq={{120,"down"},{1,"up,fwd"},{2,"up,fwd,hk"}}, frames=200}
add{name="rG__whiff__1", dist=200, seq={{70,"back"},{3,"fwd"},{2,"fwd,hp"}}, frames=200}
add{name="rH__whiff__1", dist=200, seq={{50,"back"},{3,"fwd"},{2,"fwd,hp"}}, frames=200}
add{name="rI__whiff__1", dist=200, seq={{40,"back"},{3,"fwd"},{2,"fwd,hp"}}, frames=200}
add{name="rJ__whiff__1", dist=200, seq={{70,"back"},{2,"fwd"},{2,"fwd,hp"}}, frames=200}
return { name = "charge2_blanka", tests = T }
