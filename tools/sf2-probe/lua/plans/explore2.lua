local tests = {}
-- (B) dizzy: rapid close jabs, P2 stands
tests[#tests+1] = {name="dizzy_jabs", dist=50, p2="stand", frames=400,
  seq=(function() local s={} for i=1,30 do s[#s+1]={2,"lp"}; s[#s+1]={10,""} end return s end)()}
-- stun decay: one fierce then watch 200 frames
tests[#tests+1] = {name="stun_decay", dist=60, p2="stand", frames=200, seq={{2,"hp"}}}
-- (C) actionability: block then hold down; hit then hold down; compare with pure block
tests[#tests+1] = {name="hp_blockdown", dist=60, p2="blockdown", frames=90, seq={{2,"hp"}}}
tests[#tests+1] = {name="lp_hit_down", dist=50, p2="downafter", frames=90, seq={{2,"lp"}}}
tests[#tests+1] = {name="lp_blockdown", dist=50, p2="blockdown", frames=90, seq={{2,"lp"}}}
tests[#tests+1] = {name="mp_hit_down", dist=50, p2="downafter", frames=90, seq={{2,"mp"}}}
tests[#tests+1] = {name="mp_blockdown", dist=50, p2="blockdown", frames=90, seq={{2,"mp"}}}
-- (D) close/far threshold for each button, whiffing at increasing distance (P2 crouches so nothing connects... use stand and accept hits)
for _, b in ipairs({"lp","mp","hp","lk","mk","hk"}) do
  for d = 40, 100, 4 do
    tests[#tests+1] = {name=string.format("range_%s_%d", b, d), dist=d, p2="stand", frames=8, seq={{2,b}}, settle=30}
  end
end
-- jump then release, to measure landing recovery
tests[#tests+1] = {name="jump_release", dist=150, p2="stand", frames=80, seq={{6,"up"},{60,""}}}
return { name = "explore2", tests = tests }
