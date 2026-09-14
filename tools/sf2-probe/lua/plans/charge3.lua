local T = {}
local function add(t) T[#T+1] = t end
add{name="fkA__whiff__1", dist=200, seq={{70,"down"},{2,"up,hk"}}, frames=150}
add{name="fkB__whiff__1", dist=200, seq={{70,"down"},{1,"up"},{2,"up,hk"}}, frames=150}
add{name="fkC__whiff__1", dist=200, seq={{70,"down"},{1,""},{2,"up,hk"}}, frames=150}
add{name="fkD__whiff__1", dist=200, seq={{70,"down,back"},{2,"up,back,hk"}}, frames=150}
add{name="fkE__whiff__1", dist=200, seq={{70,"down"},{2,"up,fwd,hk"}}, frames=150}
add{name="fkF__whiff__1", dist=200, seq={{70,"down"},{1,"hk"},{2,"up,hk"}}, frames=150}
add{name="fkG__whiff__1", dist=200, seq={{70,"down"},{1,"down,hk"},{2,"up,hk"}}, frames=150}
add{name="fkH__whiff__1", dist=200, seq={{70,"down"},{2,"up"},{1,"up,hk"},{3,"hk"}}, frames=150}
add{name="sbA__whiff__1", dist=200, seq={{70,"back"},{3,"fwd"},{2,"fwd,hp"}}, frames=150}
add{name="sbB__whiff__1", dist=200, seq={{70,"back"},{2,"fwd,hp"}}, frames=150}
return { name = "charge3_guile", tests = T }
