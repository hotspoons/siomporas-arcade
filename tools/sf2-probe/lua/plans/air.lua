-- Extra jump-in attempts (later in the jump, from further away) for air normals that never connected.
PROBE_DIR = os.getenv("PROBE_DIR") or "."
local T = {}
local function add(t) T[#T+1] = t end
local combos = {{100, 26}, {110, 30}, {120, 32}, {96, 34}, {130, 28}, {84, 30}}
for _, b in ipairs({"lp","mp","hp","lk","mk","hk"}) do
  local jseq = function(hold) return {{4,"up,fwd"},{hold,"fwd"},{2,"fwd,"..b},{50,""}} end
  for r, c in ipairs(combos) do add{name="air-"..b.."__hit__"..(10 + r), dist=c[1], p2="upafter", seq=jseq(c[2]), frames=130} end
  for r, c in ipairs(combos) do add{name="air-"..b.."__block__"..(10 + r), dist=c[1], p2="blockup", seq=jseq(c[2]), frames=130} end
  add{name="air-"..b.."__chit__11", dist=110, p2="crouchup", seq=jseq(30), frames=130}
  add{name="air-"..b.."__chit__12", dist=100, p2="crouchup", seq=jseq(34), frames=130}
end
return { name = (os.getenv("PROBE_CHAR") or "ryu") .. "-air", tests = T }
