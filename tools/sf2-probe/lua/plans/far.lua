-- Supplementary far-version tests: hit/block/crouch variants at a distance just past each button's
-- measured close range. PROBE_FAR="lp:76,mp:82,hp:92,lk:52,mk:52,hk:92" (from <char>.raw.json closeRange).
PROBE_DIR = os.getenv("PROBE_DIR") or "."
local T = {}
local function add(t) T[#T+1] = t end
local far = {}
for k, v in string.gmatch(os.getenv("PROBE_FAR") or "", "(%a+):(%d+)") do far[k] = tonumber(v) end
for _, b in ipairs({"lp","mp","hp","lk","mk","hk"}) do
  local d = far[b] or 80
  for r = 1, 3 do add{name="stand-"..b.."__fhit__"..(20 + r), dist=d, p2="upafter", seq={{2,b}}, frames=120} end
  add{name="stand-"..b.."__fblock__21", dist=d, p2="blockup", seq={{2,b}}, frames=120}
  add{name="stand-"..b.."__chit__21", dist=d, p2="crouchup", seq={{2,b}}, frames=120}
  add{name="stand-"..b.."__cblock__21", dist=d, p2="cblockup", seq={{2,b}}, frames=120}
  for r = 1, 2 do add{name="crouch-"..b.."__fhit__"..(20 + r), dist=d, p2="upafter", seq={{4,"down"},{2,"down,"..b},{40,"down"}}, frames=140} end
end
return { name = (os.getenv("PROBE_CHAR") or "ryu") .. "-far", tests = T }
