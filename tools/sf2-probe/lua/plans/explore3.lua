local tests = {}
local function far_away(t, C, P, reacted)
  -- once P1 has committed to the attack, move P2 out of reach so nothing connects (range probing)
  if C.mem:read_u8(P[1] + 0x03) ~= 0 then C.teleport(2, 900) end
end
-- (D) close/far thresholds, clean: P2 teleported away as soon as the move starts
for _, b in ipairs({"lp","mp","hp","lk","mk","hk"}) do
  for d = 36, 96, 4 do
    tests[#tests+1] = {name=string.format("range_%s_%d", b, d), dist=d, p2="stand", frames=6, seq={{2,b}}, settle=40, each=far_away}
  end
end
-- (C) actionability via jump input: hit and block, each strength
for _, b in ipairs({"lp","mp","hp"}) do
  tests[#tests+1] = {name="up_hit_"..b, dist=50, p2="upafter", frames=90, seq={{2,b}}, settle=40}
  tests[#tests+1] = {name="up_block_"..b, dist=50, p2="blockup", frames=90, seq={{2,b}}, settle=40}
  tests[#tests+1] = {name="down_hit_"..b, dist=50, p2="downafter", frames=90, seq={{2,b}}, settle=40}
end
-- landing recovery: jump, then hammer jab (press every other frame) from before landing
tests[#tests+1] = {name="land_jab", dist=150, p2="stand", frames=90, settle=40,
  seq=(function() local s={{6,"up"},{36,""}} for i=1,20 do s[#s+1]={1,"lp"}; s[#s+1]={1,""} end return s end)()}
-- dizzy: jabs with P2 re-teleported to range whenever P1 is neutral
tests[#tests+1] = {name="dizzy", dist=48, p2="stand", frames=600, settle=40,
  seq=(function() local s={} for i=1,40 do s[#s+1]={2,"lp"}; s[#s+1]={12,""} end return s end)(),
  each=function(t, C, P) if C.mem:read_u8(P[1]+3) == 0 and C.mem:read_u8(P[2]+3) == 0 then C.teleport(2, C.mem:read_i16(P[1]+6) + 48) end end}
-- throw: fwd + HP at close range
tests[#tests+1] = {name="throw_hp", dist=40, p2="stand", frames=120, settle=40, seq={{3,"fwd,hp"}}}
tests[#tests+1] = {name="throw_mp", dist=40, p2="stand", frames=120, settle=40, seq={{3,"fwd,mp"}}}
tests[#tests+1] = {name="throw_far", dist=70, p2="stand", frames=120, settle=40, seq={{3,"fwd,hp"}}}
-- specials: input check
tests[#tests+1] = {name="hadouken_lp", dist=200, p2="stand", frames=120, settle=40, seq={{3,"down"},{3,"down,fwd"},{3,"fwd"},{2,"fwd,lp"}}}
tests[#tests+1] = {name="hadouken_hp", dist=200, p2="stand", frames=120, settle=40, seq={{3,"down"},{3,"down,fwd"},{3,"fwd"},{2,"fwd,hp"}}}
tests[#tests+1] = {name="shoryuken_hp", dist=200, p2="stand", frames=120, settle=40, seq={{3,"fwd"},{3,"down"},{3,"down,fwd"},{2,"down,fwd,hp"}}}
tests[#tests+1] = {name="tatsu_hk", dist=200, p2="stand", frames=120, settle=40, seq={{3,"down"},{3,"down,back"},{3,"back"},{2,"back,hk"}}}
-- crouching and jumping normals sanity
tests[#tests+1] = {name="cr_hk", dist=60, p2="stand", frames=90, settle=40, seq={{4,"down"},{2,"down,hk"},{30,"down"}}}
tests[#tests+1] = {name="j_hk", dist=90, p2="stand", frames=90, settle=40, seq={{4,"up,fwd"},{14,"fwd"},{2,"fwd,hk"},{40,""}}}
return { name = "explore3", tests = tests }
