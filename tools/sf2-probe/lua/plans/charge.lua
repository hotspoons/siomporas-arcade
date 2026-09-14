local T = {}
local function add(t) T[#T+1] = t end
for _, n in ipairs({60, 90, 120, 150, 180, 240}) do
  add{name="rollB"..n.."__whiff__1", dist=200, seq={{n,"back"},{2,"fwd,hp"}}, frames=n+60}
  add{name="rollDB"..n.."__whiff__1", dist=200, seq={{n,"down,back"},{2,"fwd,hp"}}, frames=n+60}
  add{name="vertD"..n.."__whiff__1", dist=200, seq={{n,"down"},{2,"up,hk"}}, frames=n+60}
end
add{name="rollDBrel__whiff__1", dist=200, seq={{120,"down,back"},{1,""},{2,"fwd,hp"}}, frames=200}
add{name="rollBhold__whiff__1", dist=200, seq={{120,"back"},{6,"fwd"},{2,"fwd,hp"}}, frames=200}
add{name="rollBneutral__whiff__1", dist=200, seq={{120,"back"},{4,""},{2,"hp"}}, frames=200}
return { name = "charge_blanka", tests = T }
